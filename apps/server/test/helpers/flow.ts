// 生命週期測試共用的流程：建立 Team、Project、Task，派工給模擬 Runner，並操作 Gate 與 RunControl。

import type { AcceptanceCriterionKind, Role, Run } from "@orbis/api-contract";
import type { EventKind, ServerToRunner } from "@orbis/protocol";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { Database } from "../../src/db/client";
import { acceptanceCriteria, type projects, runs, tasks } from "../../src/db/schema";
import { client, type SeededTeam, seedProject, seedReadyTask, seedTeam } from "./api";
import { type Harness, type MockRunner, startHarness, waitUntil } from "./runner-harness";

export const RUNNING: EventKind = {
  kind: "status_changed",
  status: "running",
  gate: null,
  message: null,
};
export const AWAITING_REVIEW: EventKind = {
  kind: "status_changed",
  status: "awaiting_gate",
  gate: "review",
  message: null,
};
export const AWAITING_PLAN: EventKind = {
  kind: "status_changed",
  status: "awaiting_gate",
  gate: "plan",
  message: null,
};
export const PLAN_PROPOSED = (text: string): EventKind => ({
  kind: "plan_proposed",
  body: { type: "inline", text },
  source: "plan_mode",
});
export const RUN_DIFF: EventKind = {
  kind: "run_diff",
  base_commit: "a".repeat(40),
  files: [
    {
      path: "src/login.ts",
      old_path: null,
      change: "modified",
      binary: false,
      old: { type: "inline", text: "a\n" },
      new: { type: "inline", text: "b\n" },
    },
  ],
};

export interface Flow {
  h: Harness;
  db: Database;
  team: SeededTeam;
  project: typeof projects.$inferSelect;
  repoId: string;
  as(role: Role): ReturnType<typeof client>;
  close(): Promise<void>;
}

/** 啟動 Server 與模擬 Runner 的環境，建立 Team（四種 Role 各一位）與 Project。 */
export async function startFlow(
  db: Database,
  projectOverrides: Partial<typeof projects.$inferInsert> = {},
): Promise<Flow> {
  const h = await startHarness(db);
  const team = await seedTeam(db);
  const { project, repo } = await seedProject(db, team.teamId, projectOverrides);
  return {
    h,
    db,
    team,
    project,
    repoId: repo.id,
    as: (role) => client(h.ctx.app, team.members[role].cookie),
    close: () => h.close(),
  };
}

export interface StartedRun {
  mine: MockRunner;
  task: typeof tasks.$inferSelect;
  run: z.infer<typeof Run>;
  offer: Extract<ServerToRunner, { type: "dispatch_offer" }>;
  criteria: (typeof acceptanceCriteria.$inferSelect)[];
  /** 以這個 Dispatch 送出 Event 並等 ack。 */
  send(kind: EventKind): Promise<unknown>;
}

/**
 * 建立 Ready 的 Task（Acceptance Criterion 依 `criteria`，預設一條 command），由 Member 派工到自己的
 * Local Runner，Runner 接受並回報 running。
 */
export async function startRun(
  flow: Flow,
  options: {
    task?: Partial<typeof tasks.$inferInsert>;
    criteria?: { kind: AcceptanceCriterionKind; description: string; command?: string | null }[];
    runner?: MockRunner;
  } = {},
): Promise<StartedRun> {
  const { h, db, team } = flow;
  const mine = options.runner ?? (await h.pairRunner(team.members.member, "local"));
  const task = await seedReadyTask(db, flow.project, flow.repoId, options.task);
  if (options.criteria) {
    await db.delete(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id));
    await db.insert(acceptanceCriteria).values(
      options.criteria.map((c, position) => ({
        taskId: task.id,
        position,
        kind: c.kind,
        description: c.description,
        command: c.kind === "command" ? (c.command ?? null) : null,
      })),
    );
  }
  const criteria = await db
    .select()
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.taskId, task.id))
    .orderBy(acceptanceCriteria.position);
  const created = await flow.as("member").post<z.infer<typeof Run>>(`/api/tasks/${task.id}/runs`, {
    agent: "claude-code",
    runnerKind: "local",
  });
  if (created.status !== 201) throw new Error(`派工失敗：${JSON.stringify(created.body)}`);
  const run = created.body;
  await h.ctx.services.dispatcher.kick();
  const offer = await mine.next("dispatch_offer", (o) => o.run_id === run.id);
  mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
  await waitUntil(async () => (await runRow(db, run.id))?.status === "starting");
  await mine.eventAcked(offer.dispatch_id, run.id, RUNNING);
  const send = (kind: EventKind) => mine.eventAcked(offer.dispatch_id, run.id, kind);
  return { mine, task, run, offer, criteria, send };
}

export async function runRow(db: Database, runId: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId));
  return row;
}

export async function taskRow(db: Database, taskId: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!row) throw new Error("Task 不存在");
  return row;
}

/** 讀出 Runner 收到的下一個某種 run_control，並回覆 applied（或指定的結果）。 */
export async function control(
  mine: MockRunner,
  action: string,
  reply: Record<string, unknown> = {},
) {
  const frame = await mine.next("run_control", (f) => f.action === action);
  mine.send({
    type: "run_control_result",
    control_id: frame.control_id,
    run_id: frame.run_id,
    dispatch_id: frame.dispatch_id,
    outcome: "applied",
    ...reply,
  });
  return frame;
}

/** Task 上等待中的 Gate（最新的一個）。 */
export async function openGate(flow: Flow, taskId: string) {
  const list = await flow
    .as("viewer")
    .get<{ id: string; kind: string; decision: string | null }[]>(`/api/tasks/${taskId}/gates`);
  const open = [...list.body].reverse().find((g) => g.decision === null);
  if (!open) throw new Error("沒有等待中的 Gate");
  return open;
}
