import type { DraftTask, Task, TaskStatus } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import {
  acceptanceBar,
  type BoardInput,
  boardGroups,
  boardListColumns,
  canAddTo,
  needsCount,
} from "./board-model";

function task(id: string, status: TaskStatus, patch: Partial<Task> = {}): Task {
  return {
    id,
    key: `ORB-${id}`,
    projectId: "p1",
    repoId: "r1",
    title: `Task ${id}`,
    description: "",
    status,
    doneReason: null,
    assigneeMemberId: null,
    specPath: null,
    dependsOn: [],
    planGateEnabled: null,
    createdByMemberId: null,
    createdAt: "2026-10-25T08:00:00Z",
    updatedAt: "2026-10-25T08:00:00Z",
    ...patch,
  };
}

const draft: DraftTask = {
  id: "d1",
  projectId: "p1",
  batchId: "b1",
  position: 1,
  proposedByRunId: null,
  repoId: null,
  spec: null,
  title: "草稿",
  description: "",
  acceptanceCriteria: [],
  dependsOn: [],
  createdAt: "2026-10-25T08:00:00Z",
  updatedAt: "2026-10-25T08:00:00Z",
};

const tasks = [
  task("1", "running", { assigneeMemberId: "me" }),
  task("2", "review_gate"),
  task("3", "ready", { dependsOn: ["1"] }),
  task("4", "done"),
  task("5", "backlog", { assigneeMemberId: "me" }),
];

const input = (patch: Partial<BoardInput> = {}): BoardInput => ({
  tasks,
  drafts: [draft],
  needsTaskIds: new Set(["2"]),
  runs: new Map([
    ["1", { id: "run-1", status: "running" as const, gate: null, agent: "claude-code" }],
    [
      "2",
      { id: "run-2", status: "awaiting_gate" as const, gate: "review" as const, agent: "codex" },
    ],
  ]),
  acceptance: new Map([["2", { passed: 2, failed: 0, total: 3 }]]),
  meId: "me",
  filter: "all",
  ...patch,
});

describe("boardGroups", () => {
  it("依生命週期的順序分組；列表拿掉空的組，草稿列在待辦最後", () => {
    const groups = boardGroups(input(), false);
    expect(groups.map((g) => g.status)).toEqual([
      "backlog",
      "ready",
      "running",
      "review_gate",
      "done",
    ]);
    expect(groups[0]?.rows.map((r) => r.kind)).toEqual(["task", "draft"]);
    expect(boardGroups(input(), true)).toHaveLength(9);
  });

  it("每列的 needs、Run、live、驗收與依賴", () => {
    const rows = boardGroups(input(), true).flatMap((g) => g.rows);
    const byId = (id: string) => rows.find((r) => r.kind === "task" && r.task.id === id);
    expect(byId("1")).toMatchObject({ needs: false, live: true, run: { agent: "claude-code" } });
    expect(byId("2")).toMatchObject({
      needs: true,
      live: false,
      acceptance: { passed: 2, total: 3 },
    });
    expect(byId("3")).toMatchObject({ blockedBy: ["ORB-1"], run: null, acceptance: null });
  });

  it("待我處理與指派給我的篩選不列草稿", () => {
    const needs = boardGroups(input({ filter: "needs" }), false);
    expect(needs.flatMap((g) => g.rows.map((r) => r.key))).toEqual(["2"]);
    const mine = boardGroups(input({ filter: "mine" }), false);
    expect(mine.flatMap((g) => g.rows.map((r) => r.key))).toEqual(["5", "1"]);
  });

  it("待我處理的數字", () => {
    expect(needsCount(input())).toBe(1);
  });
});

describe("欄位與進度", () => {
  it("820 以上顯示代理與更新時間", () => {
    expect(boardListColumns(820).wide).toBe(true);
    expect(boardListColumns(819)).toEqual({
      wide: false,
      template: "10px 60px minmax(120px,1fr) 96px 64px 104px",
    });
  });

  it("只有待辦與就緒可以直接新增；進度條有失敗時是紅色", () => {
    expect(canAddTo("backlog")).toBe(true);
    expect(canAddTo("running")).toBe(false);
    expect(acceptanceBar({ passed: 1, failed: 1, total: 4 })).toEqual({
      percent: 25,
      failed: true,
    });
    expect(acceptanceBar({ passed: 0, failed: 0, total: 0 })).toEqual({
      percent: 0,
      failed: false,
    });
  });
});
