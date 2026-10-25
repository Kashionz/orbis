// 執行中的 Run 操作（ARCHITECTURE §7、ADR-0016）：傳訊息與收回、Event 的作者、派工的推理強度、
// 切換設定、換 Agent 與用量分段、模型目錄。Runner 由 runner harness 模擬。

import {
  AgentCatalogResponse,
  API_ROUTES,
  apiPath,
  type Run,
  type RunEvent,
  RunSettings,
} from "@orbis/api-contract";
import type { ModelInfo } from "@orbis/protocol";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAgentSegments, runs, taskMembers } from "../src/db/schema";
import { client, expectContract, seedMember, seedReadyTask } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import { AWAITING_REVIEW, type Flow, RUN_DIFF, runRow, startFlow, startRun } from "./helpers/flow";
import { type MockAgent, waitUntil } from "./helpers/runner-harness";

const MODELS: ModelInfo[] = [
  { id: "sonnet", name: "Sonnet", tag: null, effort: { kind: "adjustable" }, source: "profile" },
  { id: "haiku", name: "Haiku", tag: null, effort: { kind: "unsupported" }, source: "profile" },
];

const AGENTS: MockAgent[] = [
  { id: "claude-code", info: { models: MODELS, display_name: "Claude Code", vendor: "Anthropic" } },
  {
    id: "codex",
    info: {
      models: [
        {
          id: "gpt",
          name: "GPT",
          tag: null,
          effort: { kind: "fixed", level: "std" },
          source: "session",
        },
      ],
      display_name: "Codex",
      signed_in: true,
    },
  },
];

describe.skipIf(dbSkipReason !== null)("執行中的 Run 操作", () => {
  let database: TestDatabase;
  let flow: Flow;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    flow = await startFlow(database.db);
  });

  afterEach(async () => {
    await flow?.close();
  });

  async function started() {
    const runner = await flow.h.pairRunner(flow.team.members.member, "local", AGENTS);
    return startRun(flow, { runner, task: { createdByMemberId: flow.team.members.member.id } });
  }

  describe("run-prompt", () => {
    it("排隊送出；收回；已送出後不能收回", async () => {
      const s = await started();
      const path = apiPath(API_ROUTES.runPrompts, { runId: s.run.id });
      const res = await flow
        .as("member")
        .post<{ controlId: string }>(path, { text: " 順便改文案 " });
      expect(res.status).toBe(202);
      const frame = await s.mine.next("run_control", (f) => f.action === "prompt");
      expect(frame).toMatchObject({
        control_id: res.body.controlId,
        action: "prompt",
        prompt: [{ type: "text", text: "順便改文案" }],
        source: "user",
        delivery: "queue",
      });

      const withdraw = apiPath(API_ROUTES.runPrompt, {
        runId: s.run.id,
        controlId: res.body.controlId,
      });
      expect((await flow.as("member").delete(withdraw)).status).toBe(202);
      const w = await s.mine.next("run_control", (f) => f.action === "withdraw_prompt");
      expect(w).toMatchObject({ prompt_control_id: res.body.controlId });

      const second = await flow
        .as("member")
        .post<{ controlId: string }>(path, { text: "停一下", delivery: "interrupt" });
      const interrupt = await s.mine.next("run_control", (f) => f.action === "prompt");
      expect(interrupt).toMatchObject({ delivery: "interrupt" });
      await s.send({
        kind: "prompt_submitted",
        prompt: [{ type: "text", text: "停一下" }],
        source: "user",
        control_id: second.body.controlId,
      });
      const late = await flow
        .as("member")
        .delete(
          apiPath(API_ROUTES.runPrompt, { runId: s.run.id, controlId: second.body.controlId }),
        );
      expect(late.status).toBe(409);
      expect(late.body).toMatchObject({ error: "prompt_already_submitted" });
      const unknown = await flow.as("member").delete(
        apiPath(API_ROUTES.runPrompt, {
          runId: s.run.id,
          controlId: "0192f0c4-7b1a-7c3e-9a51-3f1d2c4b5a6e",
        }),
      );
      expect(unknown.status).toBe(404);
    });

    it("權限：Viewer 403，被分享為可操作的 Viewer 可以", async () => {
      const s = await started();
      const path = apiPath(API_ROUTES.runPrompts, { runId: s.run.id });
      expect((await flow.as("viewer").post(path, { text: "x" })).status).toBe(403);
      await flow.db
        .insert(taskMembers)
        .values({ taskId: s.task.id, memberId: flow.team.members.viewer.id, role: "edit" });
      expect((await flow.as("viewer").post(path, { text: "x" })).status).toBe(202);
    });

    it("Gate 等待中 409 run_not_accepting_prompts；Run 結束後 409 run_finished", async () => {
      const s = await started();
      const path = apiPath(API_ROUTES.runPrompts, { runId: s.run.id });
      await s.send(RUN_DIFF);
      await s.send(AWAITING_REVIEW);
      await waitUntil(async () => (await runRow(flow.db, s.run.id))?.status === "awaiting_gate");
      const waiting = await flow.as("member").post(path, { text: "x" });
      expect(waiting.body).toMatchObject({ error: "run_not_accepting_prompts" });
      await flow.db.update(runs).set({ status: "failed" }).where(eq(runs.id, s.run.id));
      const finished = await flow.as("member").post(path, { text: "x" });
      expect(finished.status).toBe(409);
      expect(finished.body).toMatchObject({ error: "run_finished" });
    });
  });

  describe("event-actor", () => {
    it("第一則 prompt 的作者是派工的人；帶 control_id 的 Event 是送出 RunControl 的人；其他為 null", async () => {
      const s = await started();
      await s.send({
        kind: "prompt_submitted",
        prompt: [{ type: "text", text: "做吧" }],
        source: "user",
      });
      await flow.db
        .insert(taskMembers)
        .values({ taskId: s.task.id, memberId: flow.team.members.admin.id, role: "edit" });
      const sent = await flow
        .as("admin")
        .post<{ controlId: string }>(apiPath(API_ROUTES.runPrompts, { runId: s.run.id }), {
          text: "再加測試",
        });
      await s.send({
        kind: "prompt_queued",
        control_id: sent.body.controlId,
        prompt: [{ type: "text", text: "再加測試" }],
      });
      await s.send({
        kind: "prompt_submitted",
        prompt: [{ type: "text", text: "再加測試" }],
        source: "user",
        control_id: sent.body.controlId,
      });
      await s.send({ kind: "thought_chunk", text: "想" });
      const events = await flow
        .as("viewer")
        .get<RunEvent[]>(apiPath(API_ROUTES.runEvents, { runId: s.run.id }));
      const byKind = (kind: string) => events.body.filter((e) => e.event.kind === kind);
      const submitted = byKind("prompt_submitted");
      expect(submitted.map((e) => e.actorMemberId)).toEqual([
        flow.team.members.member.id,
        flow.team.members.admin.id,
      ]);
      expect(byKind("prompt_queued")[0]?.actorMemberId).toBe(flow.team.members.admin.id);
      expect(byKind("thought_chunk")[0]?.actorMemberId).toBeNull();
      expect(byKind("status_changed")[0]?.actorMemberId).toBeNull();
    });
  });

  describe("dispatch-effort 與 run-settings", () => {
    it("派工時指定推理強度：存進 Run、放進 DispatchOffer", async () => {
      const runner = await flow.h.pairRunner(flow.team.members.member, "local", AGENTS);
      const task = await seedReadyTask(flow.db, flow.project, flow.repoId);
      const created = await flow.as("member").post<Run>(`/api/tasks/${task.id}/runs`, {
        agent: "claude-code",
        runnerKind: "local",
        effort: "deep",
      });
      expect(created.body.effort).toBe("deep");
      await flow.h.ctx.services.dispatcher.kick();
      const offer = await runner.next("dispatch_offer", (o) => o.run_id === created.body.id);
      expect(offer.effort).toBe("deep");
    });

    it("切換模型與推理強度：檢查模型目錄，送 set_session_config；生效後 settings 與 Run 更新", async () => {
      const s = await started();
      const path = apiPath(API_ROUTES.runSettings, { runId: s.run.id });
      const unknown = await flow.as("member").patch(path, { model: "opus" });
      expect(unknown.status).toBe(422);
      expect(unknown.body).toMatchObject({ error: "option_unsupported" });
      const noEffort = await flow.as("member").patch(path, { model: "haiku", effort: "deep" });
      expect(noEffort.body).toMatchObject({ error: "option_unsupported" });
      expect((await flow.as("viewer").patch(path, { model: "sonnet" })).status).toBe(403);

      const ok = await flow.as("member").patch<{ controlIds: string[] }>(path, {
        model: "sonnet",
        effort: "deep",
        permissionPolicy: "manual",
      });
      expect(ok.status).toBe(202);
      expect(ok.body.controlIds).toHaveLength(2);
      const config = await s.mine.next("run_control", (f) => f.action === "set_session_config");
      expect(config).toMatchObject({ model: "sonnet", effort: "deep" });
      const policy = await s.mine.next("run_control", (f) => f.action === "set_permission_policy");
      expect(policy).toMatchObject({ policy: "manual" });

      await s.send({
        kind: "run_settings_changed",
        control_id: config.control_id,
        model: "sonnet",
        effort: "deep",
        permission_policy: null,
        not_applied: ["effort"],
        message: "不支援",
      });
      await s.send({
        kind: "run_settings_changed",
        control_id: policy.control_id,
        model: null,
        effort: null,
        permission_policy: "manual",
        not_applied: [],
        message: null,
      });
      const settings = expectContract(RunSettings, (await flow.as("viewer").get(path)).body);
      expect(settings.initial).toMatchObject({
        agent: "claude-code",
        model: null,
        permissionPolicy: "auto",
      });
      expect(settings.current).toMatchObject({
        model: "sonnet",
        effort: null,
        permissionPolicy: "manual",
      });
      expect(settings.changes).toHaveLength(2);
      expect(settings.changes[0]).toMatchObject({
        actorMemberId: flow.team.members.member.id,
        notApplied: ["effort"],
      });
      const row = await runRow(flow.db, s.run.id);
      expect(row?.model).toBe("sonnet");
      expect(row?.permissionPolicy).toBe("auto");
    });

    it("Run 結束後 409 run_finished", async () => {
      const s = await started();
      await flow.db.update(runs).set({ status: "completed" }).where(eq(runs.id, s.run.id));
      const res = await flow
        .as("member")
        .patch(apiPath(API_ROUTES.runSettings, { runId: s.run.id }), { model: "sonnet" });
      expect(res.body).toMatchObject({ error: "run_finished" });
    });
  });

  describe("agent-switch", () => {
    it("換成同一台 Runner 上的 Agent：送 switch_agent 與交接內容；Agent 分段、用量合計", async () => {
      const s = await started();
      await s.send({
        kind: "usage",
        input_tokens: 100,
        output_tokens: 10,
        thought_tokens: null,
        cached_read_tokens: null,
        cached_write_tokens: null,
        context_used_tokens: 500,
        context_window_tokens: 1000,
        cost: { amount: 1, currency: "USD" },
      });
      const path = apiPath(API_ROUTES.runSwitchAgent, { runId: s.run.id });
      const missing = await flow.as("member").post(path, { agent: "gemini" });
      expect(missing.status).toBe(422);
      expect(missing.body).toMatchObject({ error: "agent_unavailable" });
      const badModel = await flow.as("member").post(path, { agent: "codex", model: "nope" });
      expect(badModel.body).toMatchObject({ error: "option_unsupported" });

      const res = await flow
        .as("member")
        .post<{ controlId: string }>(path, { agent: "codex", model: "gpt", effort: "std" });
      expect(res.status).toBe(202);
      const frame = await s.mine.next("run_control", (f) => f.action === "switch_agent");
      expect(frame).toMatchObject({
        agent: "codex",
        model: "gpt",
        effort: "std",
        credential: "default",
      });
      if (frame.action !== "switch_agent") throw new Error("unreachable");
      expect(frame.handoff.task_spec).toMatchObject({ type: "inline" });
      expect(JSON.stringify(frame.handoff.task_spec)).toContain(s.task.key);
      expect(frame.handoff.acceptance_criteria).toHaveLength(1);
      expect(frame.handoff.review_comments).toEqual([]);

      await s.send({
        kind: "agent_switched",
        from: "claude-code",
        to: "codex",
        model: "gpt",
        control_id: res.body.controlId,
      });
      await s.send({
        kind: "usage",
        input_tokens: 40,
        output_tokens: null,
        thought_tokens: null,
        cached_read_tokens: null,
        cached_write_tokens: null,
        context_used_tokens: 50,
        context_window_tokens: 2000,
        cost: { amount: 0.5, currency: "USD" },
      });
      const run = await runRow(flow.db, s.run.id);
      expect(run?.agent).toBe("codex");
      expect(run?.model).toBe("gpt");
      expect(run?.usage).toMatchObject({
        inputTokens: 140,
        outputTokens: 10,
        contextUsedTokens: 50,
        contextWindowTokens: 2000,
        cost: { amount: 1.5, currency: "USD" },
      });
      const segments = await flow.db
        .select()
        .from(runAgentSegments)
        .where(eq(runAgentSegments.runId, s.run.id))
        .orderBy(asc(runAgentSegments.position));
      expect(segments.map((x) => [x.agent, x.model, x.effort, x.endedAt === null])).toEqual([
        ["claude-code", null, null, false],
        ["codex", "gpt", "std", true],
      ]);
      const settings = expectContract(
        RunSettings,
        (await flow.as("viewer").get(apiPath(API_ROUTES.runSettings, { runId: s.run.id }))).body,
      );
      expect(settings.current).toMatchObject({ agent: "codex", model: "gpt", effort: "std" });
      expect(settings.initial.agent).toBe("claude-code");
      expect(settings.changes.at(-1)).toMatchObject({
        agent: "codex",
        actorMemberId: flow.team.members.member.id,
      });
    });

    it("Viewer 不能換 Agent", async () => {
      const s = await started();
      const res = await flow
        .as("viewer")
        .post(apiPath(API_ROUTES.runSwitchAgent, { runId: s.run.id }), { agent: "codex" });
      expect(res.status).toBe(403);
    });
  });

  describe("model-catalog", () => {
    it("彙整自己的 Local Runner 與 Team Runner；Viewer 只看到自己的 Local Runner", async () => {
      await flow.h.pairRunner(flow.team.members.member, "local", AGENTS);
      await flow.h.pairRunner(flow.team.members.admin, "team", [
        {
          id: "claude-code",
          info: {
            models: [{ ...(MODELS[0] as ModelInfo), source: "session", name: "Sonnet 5.5" }],
            display_name: "Claude Code",
            signed_in: false,
            login_hint: { kind: "cli", command: "claude login" },
          },
        },
      ]);
      const res = await flow.as("member").get(API_ROUTES.agentCatalog);
      const catalog = expectContract(AgentCatalogResponse, res.body);
      expect(catalog.map((a) => a.agentId)).toEqual(["claude-code", "codex"]);
      const claude = catalog[0];
      expect(claude?.tool).toBe("Claude Code");
      expect(claude?.vendor).toBe("Anthropic");
      expect(claude?.models.find((m) => m.id === "sonnet")).toMatchObject({
        source: "session",
        name: "Sonnet 5.5",
      });
      expect(claude?.signedIn).toBe(false);
      expect(claude?.loginHint).toEqual({ kind: "cli", command: "claude login" });
      expect(catalog[1]?.signedIn).toBe(true);

      const viewer = await seedMember(flow.db, flow.team.teamId, "viewer");
      const empty = await client(flow.h.ctx.app, viewer.cookie).get(API_ROUTES.agentCatalog);
      expect(empty.body).toEqual([]);
    });
  });
});
