// 互動式終端機（ADR-0014）：開啟的權限與 Team 設定、上限與封存、WebSocket 只接受開啟者、輸入輸出的轉送與關閉紀錄。

import {
  API_ROUTES,
  apiPath,
  type Run,
  TerminalCreated,
  type TerminalServerMessage,
} from "@orbis/api-contract";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { runControls, runners, tasks, teams, terminalSessions } from "../src/db/schema";
import { expectContract, seedReadyTask } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import { type Flow, RUNNING, runRow, startFlow, startRun } from "./helpers/flow";
import { type MockRunner, waitUntil } from "./helpers/runner-harness";

const ORIGIN = "http://localhost:5173";

describe.skipIf(dbSkipReason !== null)("互動式終端機", () => {
  let database: TestDatabase;
  let flow: Flow;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    flow = await startFlow(database.db, {}, { terminalAuthzRecheckMs: 100 });
  });

  afterEach(async () => {
    await flow?.close();
  });

  /** 開一條終端機的 WebSocket，收集 Server 送來的訊息。 */
  async function connect(wsUrl: string, cookie: string | null, origin: string | null = ORIGIN) {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const ws = new WebSocket(`ws://127.0.0.1:${flow.h.server.port}${wsUrl}`, { headers });
    const messages: TerminalServerMessage[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    const opened = await new Promise<boolean>((resolve) => {
      ws.once("open", () => resolve(true));
      ws.once("error", () => resolve(false));
      ws.once("unexpected-response", () => resolve(false));
    });
    return { ws, messages, closed, opened };
  }

  async function open(role: "member" | "admin" | "owner" | "viewer", runId: string) {
    return flow.as(role).post<TerminalCreated>(apiPath(API_ROUTES.runTerminals, { runId }), {
      cols: 80,
      rows: 24,
    });
  }

  /** Admin 派工到 Team Runner、Runner 接受並回報 running。 */
  async function teamRun(): Promise<{ runner: MockRunner; run: Run }> {
    const runner = await flow.h.pairRunner(flow.team.members.admin, "team");
    const task = await seedReadyTask(flow.db, flow.project, flow.repoId);
    const created = await flow.as("admin").post<Run>(`/api/tasks/${task.id}/runs`, {
      agent: "claude-code",
      runnerKind: "team",
    });
    await flow.h.ctx.services.dispatcher.kick();
    const offer = await runner.next("dispatch_offer", (o) => o.run_id === created.body.id);
    runner.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
    await waitUntil(async () => (await runRow(flow.db, created.body.id))?.status === "starting");
    await runner.eventAcked(offer.dispatch_id, created.body.id, RUNNING);
    return { runner, run: created.body };
  }

  it("Local Runner 的擁有者開啟、輸入、輸出、結束，只記錄開與關", async () => {
    const s = await startRun(flow);
    const res = await open("member", s.run.id);
    expect(res.status).toBe(201);
    const created = expectContract(TerminalCreated, res.body);
    expect(created.wsUrl).toBe(apiPath(API_ROUTES.terminalWs, { terminalId: created.terminalId }));
    const frame = await s.mine.next("terminal_open");
    expect(frame).toMatchObject({
      terminal_id: created.terminalId,
      run_id: s.run.id,
      cols: 80,
      rows: 24,
    });

    const client = await connect(created.wsUrl, flow.team.members.member.cookie);
    expect(client.opened).toBe(true);
    client.ws.send(JSON.stringify({ type: "input", data: Buffer.from("ls\r").toString("base64") }));
    const input = await s.mine.next("terminal_input");
    expect(Buffer.from(input.data, "base64").toString()).toBe("ls\r");
    client.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    expect(await s.mine.next("terminal_resize")).toMatchObject({ cols: 100, rows: 30 });
    client.ws.send("not json");
    s.mine.send({
      type: "terminal_output",
      terminal_id: created.terminalId,
      data: Buffer.from("README.md\r\n").toString("base64"),
    });
    await waitUntil(async () => client.messages.some((m) => m.type === "output"));
    expect(client.messages.find((m) => m.type === "error")).toMatchObject({
      code: "invalid_message",
    });

    s.mine.send({
      type: "terminal_exited",
      terminal_id: created.terminalId,
      code: 0,
      reason: "exited",
      message: null,
    });
    await client.closed;
    expect(client.messages.at(-1)).toEqual({ type: "exited", code: 0, reason: "exited" });
    const [row] = await flow.db
      .select()
      .from(terminalSessions)
      .where(eq(terminalSessions.id, created.terminalId));
    expect(row).toMatchObject({ memberId: flow.team.members.member.id, closeReason: "exited" });
    expect(row?.closedAt).not.toBeNull();
    expect(Object.keys(row ?? {})).not.toContain("output");
  });

  it("WebSocket 只接受開啟者的 session 與 Web 的 Origin；關閉 WebSocket 就關閉終端機", async () => {
    const s = await startRun(flow);
    const created = expectContract(TerminalCreated, (await open("member", s.run.id)).body);
    expect((await connect(created.wsUrl, flow.team.members.admin.cookie)).opened).toBe(false);
    expect((await connect(created.wsUrl, null)).opened).toBe(false);
    expect(
      (await connect(created.wsUrl, flow.team.members.member.cookie, "https://evil.test")).opened,
    ).toBe(false);
    expect((await connect(created.wsUrl, flow.team.members.member.cookie, null)).opened).toBe(
      false,
    );

    const client = await connect(created.wsUrl, flow.team.members.member.cookie);
    expect(client.opened).toBe(true);
    // 只能接一次
    expect((await connect(created.wsUrl, flow.team.members.member.cookie)).opened).toBe(false);
    client.ws.close();
    expect(await s.mine.next("terminal_close")).toMatchObject({ terminal_id: created.terminalId });
  });

  it("連線期間失去權限就關閉；登出時關閉這個 session 的終端機", async () => {
    const s = await startRun(flow);
    const first = expectContract(TerminalCreated, (await open("member", s.run.id)).body);
    const client = await connect(first.wsUrl, flow.team.members.member.cookie);
    expect(client.opened).toBe(true);
    // 這台 Runner 不再屬於開啟者
    await flow.db
      .update(runners)
      .set({ memberId: flow.team.members.admin.id })
      .where(eq(runners.id, s.mine.runnerId));
    await client.closed;
    expect(client.messages.some((m) => m.type === "error" && m.code === "forbidden")).toBe(true);
    expect(await s.mine.next("terminal_close")).toMatchObject({ terminal_id: first.terminalId });

    await flow.db
      .update(runners)
      .set({ memberId: flow.team.members.member.id })
      .where(eq(runners.id, s.mine.runnerId));
    const second = expectContract(TerminalCreated, (await open("member", s.run.id)).body);
    await flow.as("member").post("/api/auth/logout");
    expect(await s.mine.next("terminal_close")).toMatchObject({ terminal_id: second.terminalId });
  });

  it("Local Runner：其他人（含 Admin）403", async () => {
    const s = await startRun(flow);
    expect((await open("admin", s.run.id)).status).toBe(403);
    expect((await open("viewer", s.run.id)).status).toBe(403);
  });

  it("Local Runner 的擁有者在 Task 上只能檢視時 403（和能回覆權限請求的人一致）", async () => {
    const s = await startRun(flow, { task: { createdByMemberId: flow.team.members.admin.id } });
    await flow.db.update(tasks).set({ generalAccess: "team_view" }).where(eq(tasks.id, s.task.id));
    const res = await open("member", s.run.id);
    expect(res.status).toBe(403);
    await flow.db.update(tasks).set({ generalAccess: "team_edit" }).where(eq(tasks.id, s.task.id));
    expect((await open("member", s.run.id)).status).toBe(201);
  });

  it("Team Runner：只限 Admin 以上，而且 Team 設定要打開", async () => {
    const { run } = await teamRun();
    expect((await open("member", run.id)).status).toBe(403);
    const disabled = await open("admin", run.id);
    expect(disabled.status).toBe(403);
    expect(disabled.body).toMatchObject({ error: "terminal_disabled" });
    await flow.db
      .update(teams)
      .set({ allowTeamRunnerTerminal: true })
      .where(eq(teams.id, flow.team.teamId));
    expect((await open("admin", run.id)).status).toBe(201);
  });

  it("每個 Run 最多 3 個；Worktree 封存後 409；Runner 離線 409；Runner 斷線時結束", async () => {
    const s = await startRun(flow);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await open("member", s.run.id);
      expect(res.status).toBe(201);
      ids.push(res.body.terminalId);
    }
    const limit = await open("member", s.run.id);
    expect(limit.body).toMatchObject({ error: "terminal_limit" });

    s.mine.close();
    await waitUntil(async () => !flow.h.ctx.services.hub.isOnline(s.mine.runnerId));
    await waitUntil(async () => {
      const rows = await flow.db
        .select()
        .from(terminalSessions)
        .where(eq(terminalSessions.runId, s.run.id));
      return rows.every((r) => r.closeReason === "runner_shutdown");
    });
    const offline = await open("member", s.run.id);
    expect(offline.body).toMatchObject({ error: "runner_offline" });

    await flow.db.insert(runControls).values({
      controlId: "0192f0c4-7b1a-7c3e-9a51-3f1d2c4b5a6e",
      runId: s.run.id,
      dispatchId: s.offer.dispatch_id,
      action: "archive",
      payload: { action: "archive" },
      outcome: "applied",
      resolvedAt: new Date(),
    });
    const archived = await open("member", s.run.id);
    expect(archived.body).toMatchObject({ error: "worktree_archived" });
  });
});
