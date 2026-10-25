// 執行中的 Run 操作（ARCHITECTURE §7）：傳訊息與收回、切換模型／推理強度／Permission Policy、換 Agent，
// 互動式終端機與模型目錄。切換以 RunControl 送給 Runner，生效時 Runner 送 Event，所以 API 回 202。

import {
  type AgentSwitchRequested,
  API_ROUTES,
  apiPath,
  CreateRunPromptInput,
  CreateTerminalInput,
  type Effort,
  type RunPromptCreated,
  type RunSettingsUpdated,
  type RunStatus,
  SwitchAgentInput,
  TERMINAL_MAX_PER_RUN,
  type TerminalCreated,
  UpdateRunSettingsInput,
} from "@orbis/api-contract";
import type {
  DispatchCriterion,
  HandoffContext,
  ModelInfo,
  RunControlAction,
} from "@orbis/protocol";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { v7 as uuidv7 } from "uuid";
import { roleAtLeast } from "../authz/capabilities";
import { loadRunScope, type RunScope, requireProjectCapability } from "../authz/scope";
import {
  acceptanceCriteria,
  agentAvailabilities,
  gates,
  repoSpecs,
  reviewComments,
  runControls,
  runEvents,
  runners,
  teams,
  terminalSessions,
} from "../db/schema";
import { type Executor, inTransaction } from "../db/tx";
import { isTerminalRunStatus } from "../domain/run-status";
import { ApiError, forbidden, notFound, readId, readJson } from "../http/errors";
import type { Actor, AppEnv } from "../http/session";
import { agentCatalog } from "../runner/agent-catalog";
import type { AvailabilityDetails } from "../runner/dispatch-options";
import { currentDispatch } from "../runs/run-control";
import { loadRunSettings } from "../runs/run-settings";
import type { Services } from "../services";

/** 不接受執行中訊息的狀態：Gate 等待時改用 Gate 的退回；還沒開始或正在 Verification 時沒有回合可以接。 */
const NOT_ACCEPTING_PROMPTS: readonly RunStatus[] = [
  "queued",
  "dispatched",
  "verifying",
  "awaiting_gate",
];

function requireNotFinished(scope: RunScope): void {
  if (isTerminalRunStatus(scope.run.status)) {
    throw new ApiError(409, "run_finished", "Run 已經結束");
  }
}

/** 能派工到這個 Run 所在的那種 Runner（換 Agent、換 Permission Policy 和派工時用同一條規則）。 */
function requireDispatchRule(actor: Actor, scope: RunScope): void {
  requireProjectCapability(
    actor,
    scope,
    scope.run.target === "local" ? "dispatch_local" : "dispatch_team",
  );
}

/** 這台 Runner 上某個 Agent 回報的 model；沒有回報（無法列出）時為 null。 */
async function reportedModels(
  db: Executor,
  runnerId: string | null,
  agent: string,
): Promise<{ available: boolean; credential: string | null; models: ModelInfo[] | null } | null> {
  if (!runnerId) return null;
  const rows = await db
    .select()
    .from(agentAvailabilities)
    .where(and(eq(agentAvailabilities.runnerId, runnerId), eq(agentAvailabilities.agent, agent)))
    .orderBy(asc(agentAvailabilities.credential));
  const row = rows.find((r) => r.available) ?? rows[0];
  if (!row) return null;
  const details = (row.details ?? {}) as AvailabilityDetails;
  const models = details.catalog?.models ?? [];
  return {
    available: row.available,
    credential: row.credential === "" ? null : row.credential,
    models: models.length > 0 ? models : null,
  };
}

/**
 * 檢查 model 與推理強度是不是這個 Agent 支援的；Runner 沒有回報 model 時不檢查（由 Runner 以 `not_applied` 回報）。
 */
function checkModelOptions(
  models: ModelInfo[] | null,
  model: string | null | undefined,
  effort: Effort | null | undefined,
): void {
  if (!models) return;
  const info = model ? models.find((m) => m.id === model) : undefined;
  if (model && !info) {
    throw new ApiError(422, "option_unsupported", `這個 Agent 沒有 ${model} 這個 model`);
  }
  if (effort && info) {
    const support = info.effort;
    if (support.kind === "unsupported" || (support.kind === "fixed" && support.level !== effort)) {
      throw new ApiError(422, "option_unsupported", `${info.name} 不支援這個推理強度`);
    }
  }
}

/** 交接 prompt 中只有 Server 知道的部分（ADR-0016）：規格、驗收條件、還沒送出的審查留言。 */
async function handoffContext(db: Executor, scope: RunScope): Promise<HandoffContext> {
  const { task, run } = scope;
  const lines = [`# ${task.key} ${task.title}`];
  if (task.description.trim() !== "") lines.push("", task.description.trim());
  if (task.repoSpecId) {
    const [spec] = await db.select().from(repoSpecs).where(eq(repoSpecs.id, task.repoSpecId));
    if (spec) lines.push("", `Spec：${spec.path}`);
  }
  const criteria = await db
    .select()
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.taskId, task.id))
    .orderBy(asc(acceptanceCriteria.position));
  const comments = await db
    .select({ comment: reviewComments })
    .from(reviewComments)
    .innerJoin(gates, eq(gates.id, reviewComments.gateId))
    .where(and(eq(gates.runId, run.id), isNull(gates.decision)))
    .orderBy(asc(reviewComments.createdAt), asc(reviewComments.id));
  return {
    task_spec: { type: "inline", text: lines.join("\n") },
    acceptance_criteria: criteria.map(
      (c): DispatchCriterion => ({
        criterion_id: c.id,
        kind: c.kind,
        description: c.description,
        command: c.kind === "command" ? c.command : null,
      }),
    ),
    review_comments: comments.map(({ comment }) => ({
      path: comment.path,
      line: comment.line,
      url: comment.url,
      body: comment.body,
    })),
  };
}

export function createRunOpsRoutes(s: Services): Hono<AppEnv> {
  const { db, auth } = s;
  const app = new Hono<AppEnv>();

  async function send(scope: RunScope, actor: Actor, actions: RunControlAction[]) {
    return inTransaction(db, async (uow) => {
      const ids: string[] = [];
      for (const action of actions) {
        ids.push(await s.runControls.send(uow.tx, scope.run.id, action, uow, actor.memberId));
      }
      return ids;
    });
  }

  /** 執行中傳訊息：回合中或等待權限回覆時排隊（`queue`），或中斷目前的回合後送出（`interrupt`）。 */
  app.post(API_ROUTES.runPrompts, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "edit_task");
    const input = await readJson(c, CreateRunPromptInput);
    requireNotFinished(scope);
    if (NOT_ACCEPTING_PROMPTS.includes(scope.run.status)) {
      throw new ApiError(409, "run_not_accepting_prompts", "Run 目前不接受執行中的訊息");
    }
    const [controlId] = await send(scope, actor, [
      {
        action: "prompt",
        prompt: [{ type: "text", text: input.text }],
        source: "user",
        delivery: input.delivery,
      },
    ]);
    return c.json({ controlId } as RunPromptCreated, 202);
  });

  /** 收回還在排隊的訊息。結果以 `prompt_withdrawn`（收回）或 `prompt_submitted`（已經送出）Event 為準。 */
  app.delete(API_ROUTES.runPrompt, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "edit_task");
    const controlId = readId(c, "controlId", "訊息");
    const [control] = await db
      .select({ action: runControls.action })
      .from(runControls)
      .where(and(eq(runControls.controlId, controlId), eq(runControls.runId, scope.run.id)));
    if (control?.action !== "prompt") throw notFound("訊息");
    requireNotFinished(scope);
    const [handled] = await db
      .select({ kind: runEvents.kind })
      .from(runEvents)
      .where(
        and(
          eq(runEvents.runId, scope.run.id),
          inArray(runEvents.kind, ["prompt_submitted", "prompt_withdrawn"]),
          sql`${runEvents.payload}->>'control_id' = ${controlId}`,
        ),
      )
      .limit(1);
    if (handled) {
      throw new ApiError(409, "prompt_already_submitted", "這則訊息已經交給 Agent 或已經收回");
    }
    await send(scope, actor, [{ action: "withdraw_prompt", prompt_control_id: controlId }]);
    return c.body(null, 202);
  });

  app.get(API_ROUTES.runSettings, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "view");
    return c.json(await loadRunSettings(db, scope.run));
  });

  /**
   * 切換模型與推理強度（`edit_task`，下一個回合開始前生效）、Permission Policy（和派工時相同的規則，
   * 從下一個權限請求開始套用）。
   */
  app.patch(API_ROUTES.runSettings, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "edit_task");
    const input = await readJson(c, UpdateRunSettingsInput);
    requireNotFinished(scope);
    const actions: RunControlAction[] = [];
    if (input.model !== undefined || input.effort !== undefined) {
      const reported = await reportedModels(db, scope.run.runnerId, scope.run.agent);
      checkModelOptions(reported?.models ?? null, input.model ?? scope.run.model, input.effort);
      actions.push({
        action: "set_session_config",
        model: input.model ?? null,
        effort: input.effort ?? null,
      });
    }
    if (input.permissionPolicy !== undefined) {
      requireDispatchRule(actor, scope);
      if (input.permissionPolicy === "yolo" && scope.run.target === "team") {
        throw new ApiError(422, "invalid_input", "Team Runner 不接受 yolo 的 Permission Policy");
      }
      actions.push({ action: "set_permission_policy", policy: input.permissionPolicy });
    }
    const controlIds = await send(scope, actor, actions);
    return c.json({ controlIds } as RunSettingsUpdated, 202);
  });

  /** 換成同一台 Runner 上可以用的另一個 Agent，接續同一個 Run 與 Worktree（ADR-0016）。 */
  app.post(API_ROUTES.runSwitchAgent, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "edit_task");
    requireDispatchRule(actor, scope);
    const input = await readJson(c, SwitchAgentInput);
    requireNotFinished(scope);
    if (input.agent === scope.run.agent) {
      throw new ApiError(422, "invalid_input", "已經是這個 Agent；換 model 請用 settings");
    }
    const reported = await reportedModels(db, scope.run.runnerId, input.agent);
    if (!reported?.available) {
      throw new ApiError(422, "agent_unavailable", `這台 Runner 上沒有可以用的 ${input.agent}`);
    }
    checkModelOptions(reported.models, input.model, input.effort);
    const [controlId] = await send(scope, actor, [
      {
        action: "switch_agent",
        agent: input.agent,
        model: input.model,
        effort: input.effort,
        credential: reported.credential,
        handoff: await handoffContext(db, scope),
      },
    ]);
    return c.json({ controlId } as AgentSwitchRequested, 202);
  });

  /**
   * 開互動式終端機（ADR-0014）。Local Runner 只限那台 Runner 的擁有者；Team Runner 只限 Admin 以上，
   * 而且 Team 設定要打開。Worktree 存在期間都能用（Run 結束後也可以）。
   */
  app.post(API_ROUTES.runTerminals, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    const input = await readJson(c, CreateTerminalInput);
    const dispatch = await currentDispatch(db, scope.run.id);
    const [runner] = dispatch
      ? await db.select().from(runners).where(eq(runners.id, dispatch.runnerId))
      : [];
    if (!dispatch || !runner) {
      throw new ApiError(409, "runner_offline", "這個 Run 還沒有在 Runner 上執行過");
    }
    if (runner.kind === "local") {
      if (runner.memberId !== actor.memberId) {
        throw forbidden("只有這台 Local Runner 的擁有者能開終端機");
      }
    } else {
      if (!roleAtLeast(scope.role, "admin")) {
        throw forbidden("Team Runner 的終端機只限 Admin 以上");
      }
      const [team] = await db
        .select({ allowed: teams.allowTeamRunnerTerminal })
        .from(teams)
        .where(eq(teams.id, actor.teamId));
      if (!team?.allowed) {
        throw new ApiError(403, "terminal_disabled", "Team 設定沒有打開 Team Runner 的終端機");
      }
    }
    const [archived] = await db
      .select({ id: runControls.controlId })
      .from(runControls)
      .where(
        and(
          eq(runControls.runId, scope.run.id),
          eq(runControls.action, "archive"),
          eq(runControls.outcome, "applied"),
        ),
      )
      .limit(1);
    if (archived) throw new ApiError(409, "worktree_archived", "Worktree 已封存");
    if (s.terminals.activeCount(scope.run.id) >= TERMINAL_MAX_PER_RUN) {
      throw new ApiError(
        409,
        "terminal_limit",
        `每個 Run 最多同時開 ${TERMINAL_MAX_PER_RUN} 個終端機`,
      );
    }
    if (!s.hub.isOnline(runner.id)) {
      throw new ApiError(409, "runner_offline", "Runner 不在線上");
    }
    const terminalId = uuidv7();
    await db.insert(terminalSessions).values({
      id: terminalId,
      runId: scope.run.id,
      memberId: actor.memberId,
      runnerId: runner.id,
      openedAt: s.clock.now(),
    });
    if (
      !s.terminals.open({
        terminalId,
        runId: scope.run.id,
        runnerId: runner.id,
        sessionId: actor.sessionId,
        cols: input.cols,
        rows: input.rows,
      })
    ) {
      throw new ApiError(409, "runner_offline", "Runner 不在線上");
    }
    return c.json(
      {
        terminalId,
        wsUrl: apiPath(API_ROUTES.terminalWs, { terminalId }),
      } satisfies TerminalCreated,
      201,
    );
  });

  app.get(API_ROUTES.agentCatalog, auth, async (c) => {
    return c.json(await agentCatalog(db, c.get("actor")));
  });

  return app;
}
