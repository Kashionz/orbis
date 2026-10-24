// Delegation 的 Orbis MCP 工具（ARCHITECTURE §9、ADR-0009）：delegate、get_run、wait_run、list_runs、
// merge_child、ask_parent、answer_child。防護規則以 Server 為準（runs/delegation-rules.ts）。
//
// - Child Run 一律派給父 Run 所在的 Runner；那台 Runner 沒有這個 Agent 時拒絕 `delegate`。
// - 判定 Verification 的 `consult` Child Run（purpose = verification）不受 Project 的 Delegation 設定限制，
//   仍受深度、數量與 Permission Policy 的限制。
// - `ask_parent`：父 Agent 以 `wait_run`／`get_run` 看到問題並以 `answer_child` 回答；父 Run 的回合已經結束時，
//   問題加入 Needs You 由人回答。

import type { ChildRunSummary, OrbisToolResult } from "@orbis/protocol";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import type { Clock } from "../clock";
import type { Database } from "../db/client";
import {
  agentAvailabilities,
  childQuestions,
  needsYouItems,
  orbisToolCalls,
  runs,
  verifications,
} from "../db/schema";
import { inTransaction, type UnitOfWork } from "../db/tx";
import { isTerminalRunStatus, NON_TERMINAL_RUN_STATUSES } from "../domain/run-status";
import type { Notify } from "../notifications/types";
import type { Dispatcher } from "../runner/dispatcher";
import { childRunSummary, runDepth } from "../runs/children";
import {
  checkDelegation,
  type DelegationRejectReason,
  MAX_ACTIVE_CHILD_RUNS,
} from "../runs/delegation-rules";
import type { RunWatch } from "./run-watch";
import { type ToolContext, ToolError, type ToolHandlers } from "./service";

type RunRow = typeof runs.$inferSelect;

/** `wait_run` 最多等多久（Agent 沒有指定、或指定得更久時）。 */
export const WAIT_RUN_MAX_MS = 10 * 60_000;
/** 阻塞中的工具多久重新檢查一次資料庫（防止漏掉喚醒）。 */
const RECHECK_MS = 15_000;

const REJECT_CODES: Record<DelegationRejectReason, ToolError["code"]> = {
  delegation_disabled: "delegation_disabled",
  agent_not_allowed: "agent_not_allowed",
  agent_unavailable: "agent_unavailable",
  depth_limit: "depth_exceeded",
  child_limit: "child_limit_exceeded",
  policy_not_allowed: "permission_not_narrower",
  parent_not_running: "invalid_state",
};

export interface DelegationToolDeps {
  db: Database;
  dispatcher: Dispatcher;
  watch: RunWatch;
  notify: Notify;
  clock: Clock;
}

export function delegationToolHandlers(deps: DelegationToolDeps): ToolHandlers {
  const { db, watch } = deps;

  /** 呼叫者的 Child Run；不是呼叫者的 Child Run 時丟出錯誤。 */
  async function ownChild(context: ToolContext, runId: string): Promise<RunRow> {
    const [child] = await db.select().from(runs).where(eq(runs.id, runId));
    if (!child || child.taskId !== context.task.id)
      throw new ToolError("not_found", "找不到這個 Run");
    if (child.parentRunId !== context.caller.id) {
      throw new ToolError("not_child", "這個 Run 不是呼叫者的 Child Run");
    }
    return child;
  }

  return {
    delegate: async (context, call) => {
      const { caller, project } = context;
      const verification = call.purpose === "verification";
      if (verification) {
        // 判定 Verification 的 Child Run 必須屬於呼叫者進行中的那一輪，而且是唯讀的 consult。
        const [running] = call.verification_id
          ? await db
              .select({ id: verifications.id })
              .from(verifications)
              .where(
                and(
                  eq(verifications.id, call.verification_id),
                  eq(verifications.runId, caller.id),
                  eq(verifications.status, "running"),
                ),
              )
          : [];
        if (!running)
          throw new ToolError("invalid_state", "這個 Run 沒有進行中的這一輪 Verification");
        if (call.mode !== "consult") {
          throw new ToolError(
            "invalid_state",
            "判定 Verification 的 Child Run 必須是 consult 模式",
          );
        }
      }
      const [{ active } = { active: 0 }] = await db
        .select({ active: count() })
        .from(runs)
        .where(
          and(eq(runs.parentRunId, caller.id), inArray(runs.status, NON_TERMINAL_RUN_STATUSES)),
        );
      const [availability] = await db
        .select({ id: agentAvailabilities.id })
        .from(agentAvailabilities)
        .where(
          and(
            eq(agentAvailabilities.runnerId, context.runnerId),
            eq(agentAvailabilities.agent, call.agent),
            eq(agentAvailabilities.available, true),
          ),
        )
        .limit(1);
      const checked = checkDelegation({
        project: verification
          ? { delegationEnabled: true, delegationAllowedAgents: null }
          : {
              delegationEnabled: project.delegationEnabled,
              delegationAllowedAgents: project.delegationAllowedAgents,
            },
        parent: {
          depth: await runDepth(db, caller),
          activeChildren: active,
          permissionPolicy: caller.permissionPolicy,
          running: !isTerminalRunStatus(caller.status),
        },
        agent: call.agent,
        agentAvailableOnParentRunner: availability !== undefined,
        permissionPolicy: call.permission_policy,
      });
      if (!checked.ok) throw new ToolError(REJECT_CODES[checked.reason], checked.message);

      // 建立 Child Run 與寫入工具呼叫的結果在同一個 transaction：Runner 重送同一個 call_id 時不會建出兩個。
      const output = await inTransaction(db, async (uow) => {
        const { tx } = uow;
        // 鎖住父 Run：同一個父 Run 的 delegate 依序處理，數量上限與 --c<n> 的序號不會算重。
        await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, caller.id)).for("update");
        // 同一個 call_id 已經處理過（重送的呼叫剛好同時到）時，回傳已保存的結果。
        const [stored] = await tx
          .select({ result: orbisToolCalls.result })
          .from(orbisToolCalls)
          .where(eq(orbisToolCalls.callId, context.callId))
          .for("update");
        const previous = stored?.result as OrbisToolResult | null | undefined;
        if (previous?.outcome === "ok") return previous.output;
        const [{ activeNow } = { activeNow: 0 }] = await tx
          .select({ activeNow: count() })
          .from(runs)
          .where(
            and(eq(runs.parentRunId, caller.id), inArray(runs.status, NON_TERMINAL_RUN_STATUSES)),
          );
        if (activeNow >= MAX_ACTIVE_CHILD_RUNS) {
          throw new ToolError(
            "child_limit_exceeded",
            `每個 Run 同時最多 ${MAX_ACTIVE_CHILD_RUNS} 個 Child Run`,
          );
        }
        const [{ siblings } = { siblings: 0 }] = await tx
          .select({ siblings: count() })
          .from(runs)
          .where(eq(runs.parentRunId, caller.id));
        const childSeq = siblings + 1;
        const branch =
          call.mode === "branch" && caller.branch ? `${caller.branch}--c${childSeq}` : null;
        if (call.mode === "branch" && !branch) {
          throw new ToolError("invalid_state", "父 Run 沒有自己的分支，不能用 branch 模式");
        }
        const [child] = await tx
          .insert(runs)
          .values({
            taskId: caller.taskId,
            parentRunId: caller.id,
            delegationMode: call.mode,
            agent: call.agent,
            model: call.model,
            permissionPolicy: checked.permissionPolicy,
            target: caller.target,
            requestedByMemberId: caller.requestedByMemberId,
            origin: verification ? "verification" : "delegation",
            branch,
            prompt: [{ type: "text", text: call.prompt }],
          })
          .returning();
        if (!child) throw new Error("建立 Child Run 失敗");
        const result: OrbisToolResult = {
          outcome: "ok",
          output: { tool: "delegate", child_run_id: child.id, branch },
        };
        await tx
          .update(orbisToolCalls)
          .set({ result, completedAt: deps.clock.now() })
          .where(and(eq(orbisToolCalls.callId, context.callId), isNull(orbisToolCalls.result)));
        uow.afterCommit(() => void deps.dispatcher.kick());
        return result.output;
      });
      return output;
    },

    get_run: async (context, call) => ({
      tool: "get_run",
      ...(await childRunSummary(db, await ownChild(context, call.run_id))),
    }),

    list_runs: async (context) => {
      const children = await db
        .select()
        .from(runs)
        .where(eq(runs.parentRunId, context.caller.id))
        .orderBy(asc(runs.createdAt), asc(runs.id));
      const summaries: ChildRunSummary[] = [];
      for (const child of children) summaries.push(await childRunSummary(db, child));
      return { tool: "list_runs", runs: summaries };
    },

    wait_run: async (context, call) => {
      const deadline = Date.now() + Math.min(call.timeout_ms ?? WAIT_RUN_MAX_MS, WAIT_RUN_MAX_MS);
      for (;;) {
        // 先監看再讀：讀取之後才發生的變化（例如 Child Run 的 ask_parent）不會漏掉。
        const change = watch.watch(call.run_id);
        try {
          const child = await ownChild(context, call.run_id);
          const summary = await childRunSummary(db, child);
          const remaining = deadline - Date.now();
          if (isTerminalRunStatus(child.status) || summary.pending_question || remaining <= 0) {
            return { tool: "wait_run", ...summary };
          }
          await change.wait(Math.min(remaining, RECHECK_MS));
        } finally {
          change.cancel();
        }
      }
    },

    merge_child: async (context, call) => {
      const child = await ownChild(context, call.run_id);
      if (child.delegationMode !== "branch" || !child.branch) {
        throw new ToolError("invalid_state", "只有 branch 模式的 Child Run 可以 merge");
      }
      if (child.status !== "completed") {
        throw new ToolError("invalid_state", "Child Run 還沒有完成，不能 merge");
      }
      // Server 不知道子分支的 HEAD；Child Run 一定在同一台 Runner，由 Runner 在本機讀取。
      return { tool: "merge_child", branch: child.branch, head_commit: null };
    },

    ask_parent: async (context, call) => {
      const { caller } = context;
      if (!caller.parentRunId)
        throw new ToolError("invalid_state", "只有 Child Run 可以向父 Run 提問");
      const parentRunId = caller.parentRunId;
      const question = await inTransaction(db, async (uow) => {
        const [created] = await uow.tx
          .insert(childQuestions)
          .values({ childRunId: caller.id, parentRunId, question: call.question })
          .returning();
        if (!created) throw new Error("建立問題失敗");
        const [parent] = await uow.tx.select().from(runs).where(eq(runs.id, parentRunId));
        // 父 Run 的回合已經結束（等待 Gate 或已結束）時，改由人回答。
        if (parent && (parent.status === "awaiting_gate" || isTerminalRunStatus(parent.status))) {
          await addQuestionToNeedsYou(uow, context, parent, created.id, call.question, deps.notify);
        }
        return created;
      });
      watch.changed(caller.id);
      for (;;) {
        const change = watch.watch(questionKey(question.id));
        try {
          const [row] = await db
            .select()
            .from(childQuestions)
            .where(eq(childQuestions.id, question.id));
          if (row?.answer) return { tool: "ask_parent", answer: row.answer };
          const [self] = await db
            .select({ status: runs.status })
            .from(runs)
            .where(eq(runs.id, caller.id));
          if (!self || isTerminalRunStatus(self.status)) {
            throw new ToolError("invalid_state", "Run 已經結束");
          }
          await change.wait(RECHECK_MS);
        } finally {
          change.cancel();
        }
      }
    },

    answer_child: async (context, call) => {
      const child = await ownChild(context, call.run_id);
      const answered = await inTransaction(db, (uow) =>
        answerQuestion(
          uow,
          call.question_id,
          child.id,
          call.answer,
          {
            runId: context.caller.id,
          },
          deps.clock.now(),
        ),
      );
      if (!answered) throw new ToolError("not_found", "找不到這個 Child Run 還沒回答的問題");
      watch.changed(questionKey(call.question_id));
      watch.changed(child.id);
      return { tool: "answer_child" };
    },
  };
}

/** RunWatch 中等待某個問題被回答的 key。 */
export function questionKey(questionId: string): string {
  return `question:${questionId}`;
}

/**
 * 回答 Child Run 的問題（父 Agent 的 `answer_child`，或人在 Needs You 回答），並結束對應的 Needs You。
 * 問題不存在或已經回答過時回傳 false。
 */
export async function answerQuestion(
  uow: UnitOfWork,
  questionId: string,
  childRunId: string | null,
  answer: string,
  by: { runId?: string; memberId?: string },
  now: Date,
): Promise<boolean> {
  const { tx } = uow;
  const [updated] = await tx
    .update(childQuestions)
    .set({
      answer,
      answeredAt: now,
      answeredByRunId: by.runId ?? null,
      answeredByMemberId: by.memberId ?? null,
    })
    .where(
      and(
        eq(childQuestions.id, questionId),
        isNull(childQuestions.answeredAt),
        childRunId ? eq(childQuestions.childRunId, childRunId) : undefined,
      ),
    )
    .returning({ id: childQuestions.id });
  if (!updated) return false;
  await tx
    .update(needsYouItems)
    .set({
      resolvedAt: now,
      resolvedByMemberId: by.memberId ?? null,
      resolution: { answeredBy: by.memberId ? "member" : "agent" },
    })
    .where(and(eq(needsYouItems.childQuestionId, questionId), isNull(needsYouItems.resolvedAt)));
  return true;
}

/** 把等待回答的問題加入 Needs You（父 Run 的負責人；沒有負責人時給派工者）並通知。 */
export async function addQuestionToNeedsYou(
  uow: UnitOfWork,
  context: Pick<ToolContext, "task">,
  parent: RunRow,
  questionId: string,
  question: string,
  notify: Notify,
): Promise<void> {
  const memberId = context.task.assigneeMemberId ?? parent.requestedByMemberId;
  const [{ existing } = { existing: 0 }] = await uow.tx
    .select({ existing: count() })
    .from(needsYouItems)
    .where(eq(needsYouItems.childQuestionId, questionId));
  if (existing > 0) return;
  const [child] = await uow.tx
    .select({ id: childQuestions.childRunId })
    .from(childQuestions)
    .where(eq(childQuestions.id, questionId));
  await uow.tx.insert(needsYouItems).values({
    projectId: context.task.projectId,
    memberId,
    kind: "child_question",
    taskId: context.task.id,
    runId: parent.id,
    childQuestionId: questionId,
    payload: { childRunId: child?.id ?? null, question },
  });
  await notify.notify(uow, {
    kind: "run_stopped",
    recipients: [memberId],
    taskId: context.task.id,
    runId: parent.id,
    title: `${context.task.key} 的 Child Run 在等待回答`,
    body: question,
  });
}
