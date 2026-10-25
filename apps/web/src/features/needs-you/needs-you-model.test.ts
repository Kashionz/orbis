import type { NeedsYouItem } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import { DICTIONARIES } from "../../i18n";
import { groupNeedsYou, stoppedRunSummary, targetOf } from "./needs-you-model";

const base = {
  memberId: "me",
  taskId: "t1",
  taskKey: "ORB-1",
  runId: "run-1",
  createdAt: "2026-10-25T08:00:00Z",
};

const permission: NeedsYouItem = {
  ...base,
  id: "n1",
  kind: "permission_request",
  permissionRequestId: "p1",
  toolCallId: null,
  title: "寫入 config.json",
  purpose: "tool",
  options: [{ optionId: "allow", name: "允許", kind: "allow_once" }],
};
const review: NeedsYouItem = { ...base, id: "n2", kind: "gate", gateKind: "review" };
const plan: NeedsYouItem = { ...base, id: "n3", kind: "gate", gateKind: "plan" };
const stopped: NeedsYouItem = {
  ...base,
  id: "n4",
  kind: "stopped_run",
  reasonCode: "verification_limit",
  attempt: 4,
  detail: null,
};
const question: NeedsYouItem = {
  ...base,
  id: "n5",
  kind: "child_question",
  questionId: "q1",
  childRunId: "run-1--c1",
  question: "要用哪個版本？",
};

describe("groupNeedsYou", () => {
  it("依權限請求、計畫關卡、審查關卡、停下來的 Run、Child Run 的問題分組，空的組不列", () => {
    const groups = groupNeedsYou([question, review, permission, stopped]);
    expect(groups.map((g) => [g.kind, g.items.map((i) => i.id)])).toEqual([
      ["permission", ["n1"]],
      ["review_gate", ["n2"]],
      ["stopped_run", ["n4"]],
      ["child_question", ["n5"]],
    ]);
    expect(groupNeedsYou([])).toEqual([]);
  });
});

describe("targetOf", () => {
  it("每一種項目前往工作區中處理的位置", () => {
    expect(targetOf(permission)).toEqual({
      taskKey: "ORB-1",
      run: "run-1",
      focus: "permission-p1",
    });
    expect(targetOf(review)).toEqual({ taskKey: "ORB-1", run: "run-1", tab: "diff" });
    expect(targetOf(plan)).toEqual({ taskKey: "ORB-1", run: "run-1" });
    expect(targetOf(stopped)).toEqual({
      taskKey: "ORB-1",
      run: "run-1",
      tab: "task",
      focus: "verification",
    });
    expect(targetOf(question)).toEqual({ taskKey: "ORB-1", run: "run-1--c1" });
  });
});

describe("stoppedRunSummary", () => {
  const zh = DICTIONARIES["zh-TW"].needsYou;
  const en = DICTIONARIES.en.needsYou;
  const item = (patch: Partial<Extract<NeedsYouItem, { kind: "stopped_run" }>>) => ({
    ...base,
    id: "s1",
    kind: "stopped_run" as const,
    reasonCode: "push_failed" as const,
    attempt: null,
    detail: null,
    ...patch,
  });

  it("依代碼顯示原因，有 detail 時接在後面", () => {
    expect(stoppedRunSummary(item({ detail: "remote: Permission denied" }), zh)).toBe(
      "push 分支失敗：remote: Permission denied",
    );
    expect(
      stoppedRunSummary(item({ reasonCode: "pr_open_failed", detail: "GitHub 回應 502" }), en),
    ).toBe("Opening the PR failed: GitHub 回應 502");
    expect(stoppedRunSummary(item({ reasonCode: "local_merge_blocked" }), zh)).toBe(
      "本機合併被擋下",
    );
  });

  it("Verification 超過上限顯示次數；舊資料沒有次數時不顯示數字", () => {
    expect(stoppedRunSummary(item({ reasonCode: "verification_limit", attempt: 4 }), zh)).toBe(
      "驗收連續失敗 4 次，超過重試上限",
    );
    expect(stoppedRunSummary(item({ reasonCode: "verification_limit" }), zh)).toBe(
      "驗收連續失敗，超過重試上限",
    );
  });
});
