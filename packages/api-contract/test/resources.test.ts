import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AcceptanceCriterion,
  NeedsYouItem,
  Project,
  Repo,
  Run,
  RunEvent,
  TASK_STATUSES,
  Task,
  Timestamp,
} from "../src/index";
import * as fixtures from "./fixtures";

/** 把 fixture 的某個欄位換掉（給 undefined 則刪掉），做出不合法的版本。 */
function withField(base: object, key: string, value: unknown): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...base };
  if (value === undefined) delete copy[key];
  else copy[key] = value;
  return copy;
}

function expectValid(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  expect(result.error?.issues ?? []).toEqual([]);
}

function expectInvalid(schema: z.ZodType, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("共用型別", () => {
  it("時間只接受 ISO 8601 的 UTC 字串", () => {
    expectValid(Timestamp, "2026-10-23T08:00:00Z");
    expectValid(Timestamp, "2026-10-23T08:00:00.123Z");
    expectInvalid(Timestamp, "2026-10-23 08:00:00");
    expectInvalid(Timestamp, "2026-10-23T08:00:00+08:00");
    expectInvalid(Timestamp, 1761206400000);
  });
});

describe("Project", () => {
  it("接受合法的 Project", () => {
    expectValid(Project, fixtures.project);
  });

  it.each([
    ["小寫前綴", "keyPrefix", "orb"],
    ["數字開頭的前綴", "keyPrefix", "1RB"],
    ["只有一個字元的前綴", "keyPrefix", "O"],
    ["超過 10 個字元的前綴", "keyPrefix", "ABCDEFGHIJK"],
    ["含連字號的前綴", "keyPrefix", "OR-B"],
    ["空白名稱", "name", ""],
    ["數字 ID", "id", 1],
    ["缺少 policy", "policy", undefined],
  ])("拒絕%s", (_, key, value) => {
    expectInvalid(Project, withField(fixtures.project, key, value));
  });

  it("拒絕不完整的 policy", () => {
    const policy = withField(fixtures.project.policy, "planGateEnabled", undefined);
    expectInvalid(Project, withField(fixtures.project, "policy", policy));
  });
});

describe("Repo", () => {
  it("接受合法的 Repo", () => {
    expectValid(Repo, fixtures.repo);
  });

  it.each([
    ["空白 owner", "owner", ""],
    ["缺少 defaultBranch", "defaultBranch", undefined],
    ["非 ISO 8601 的時間", "createdAt", "yesterday"],
  ])("拒絕%s", (_, key, value) => {
    expectInvalid(Repo, withField(fixtures.repo, key, value));
  });
});

describe("Task", () => {
  it("接受合法的 Task", () => {
    expectValid(Task, fixtures.task);
  });

  it("每個 Task 狀態都合法", () => {
    for (const status of TASK_STATUSES) {
      expectValid(Task, withField(fixtures.task, "status", status));
    }
  });

  it.each([
    ["不存在的狀態", "status", "canceled"],
    ["格式錯誤的 Task Key", "key", "orb-12"],
    ["空白標題", "title", "   "],
    ["不是陣列的 dependsOn", "dependsOn", "ORB-1"],
    ["缺少 assigneeMemberId（未指派要明確給 null）", "assigneeMemberId", undefined],
  ])("拒絕%s", (_, key, value) => {
    expectInvalid(Task, withField(fixtures.task, key, value));
  });
});

describe("AcceptanceCriterion", () => {
  it("接受合法的 Acceptance Criterion", () => {
    expectValid(AcceptanceCriterion, fixtures.acceptanceCriterion);
  });

  it("command 類型的指令可以是 null（沿用 config 的 verify）", () => {
    expectValid(AcceptanceCriterion, withField(fixtures.acceptanceCriterion, "command", null));
  });

  it("非 command 類型的指令必須是 null", () => {
    const manual = { ...fixtures.acceptanceCriterion, kind: "manual", command: null };
    expectValid(AcceptanceCriterion, manual);
    expectInvalid(AcceptanceCriterion, { ...manual, command: "pnpm test" });
  });

  it.each([
    ["不存在的類型", "kind", "unit"],
    ["不存在的結果", "result", "skipped"],
    ["負數的 position", "position", -1],
    ["小數的 position", "position", 1.5],
    ["空白描述", "description", ""],
  ])("拒絕%s", (_, key, value) => {
    expectInvalid(AcceptanceCriterion, withField(fixtures.acceptanceCriterion, key, value));
  });
});

describe("Run", () => {
  it("接受合法的頂層 Run 與 Child Run", () => {
    expectValid(Run, fixtures.run);
    expectValid(Run, fixtures.childRun);
  });

  it("尚未派工的 Run 可以沒有 model、Runner、Worktree、分支與 base commit", () => {
    expectValid(Run, {
      ...fixtures.run,
      status: "queued",
      model: null,
      runnerId: null,
      worktreePath: null,
      branch: null,
      baseCommit: null,
      startedAt: null,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    });
  });

  it("parentRunId 與 delegationMode 必須同時有值或同時為 null", () => {
    expectInvalid(Run, withField(fixtures.run, "delegationMode", "branch"));
    expectInvalid(Run, withField(fixtures.childRun, "parentRunId", null));
  });

  it.each([
    ["不存在的狀態", "status", "paused"],
    ["不存在的 Permission Policy", "permissionPolicy", "bypass"],
    ["不存在的 Runner 種類", "runnerKind", "cloud"],
    ["缺少用量", "usage", undefined],
    ["負數的用量", "usage", { inputTokens: -1, outputTokens: 0, costUsd: null }],
    ["空白的 Agent", "agent", ""],
  ])("拒絕%s", (_, key, value) => {
    expectInvalid(Run, withField(fixtures.run, key, value));
  });

  it("拒絕不存在的 Delegation 模式", () => {
    expectInvalid(Run, withField(fixtures.childRun, "delegationMode", "shared"));
  });
});

describe("RunEvent", () => {
  it("接受合法的 Event，payload 可以是任何 JSON", () => {
    expectValid(RunEvent, fixtures.runEvent);
    expectValid(RunEvent, withField(fixtures.runEvent, "payload", null));
  });

  it.each([
    ["seq 為 0（從 1 開始）", "seq", 0],
    ["小數的 seq", "seq", 1.5],
    ["空白的 kind", "kind", ""],
    ["非 ISO 8601 的 ts", "ts", "now"],
    ["缺少 runId", "runId", undefined],
  ])("拒絕%s", (_, key, value) => {
    expectInvalid(RunEvent, withField(fixtures.runEvent, key, value));
  });
});

describe("NeedsYouItem", () => {
  it.each([fixtures.needsYouPermissionRequest, fixtures.needsYouGate, fixtures.needsYouStoppedRun])(
    "接受合法的 $kind 項目",
    (item) => {
      expectValid(NeedsYouItem, item);
    },
  );

  it("依 kind 檢查各自的欄位", () => {
    expectInvalid(
      NeedsYouItem,
      withField(fixtures.needsYouPermissionRequest, "permissionRequestId", undefined),
    );
    expectInvalid(NeedsYouItem, withField(fixtures.needsYouGate, "gateKind", "merge"));
    expectInvalid(NeedsYouItem, withField(fixtures.needsYouStoppedRun, "reason", undefined));
    // gate 項目換成 stopped_run 就缺少 reason
    expectInvalid(NeedsYouItem, withField(fixtures.needsYouGate, "kind", "stopped_run"));
  });

  it("拒絕不存在的種類與格式錯誤的 Task Key", () => {
    expectInvalid(NeedsYouItem, withField(fixtures.needsYouPermissionRequest, "kind", "mention"));
    expectInvalid(NeedsYouItem, withField(fixtures.needsYouGate, "taskKey", "ORB12"));
  });
});
