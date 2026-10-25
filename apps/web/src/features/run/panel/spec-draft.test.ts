import type { AcceptanceCriterion } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import { criteriaChanges, criteriaDirty, draftsOf } from "./spec-draft";

function criterion(
  id: string,
  position: number,
  patch: Partial<AcceptanceCriterion> = {},
): AcceptanceCriterion {
  return {
    id,
    taskId: "t1",
    kind: "agent",
    description: `條件 ${id}`,
    command: null,
    position,
    result: "pending",
    resultUpdatedAt: null,
    resultSummary: null,
    checkedByRunId: null,
    checkedByMemberId: null,
    createdAt: "2026-10-25T08:00:00Z",
    updatedAt: "2026-10-25T08:00:00Z",
    ...patch,
  };
}

const original = [
  criterion("a", 0, { kind: "command", command: "pnpm test", description: "測試通過" }),
  criterion("b", 1),
];

describe("draftsOf", () => {
  it("依 position 排序，指令為空字串表示沿用 verify", () => {
    const drafts = draftsOf([original[1] as AcceptanceCriterion, criterion("c", 0)]);
    expect(drafts.map((d) => d.id)).toEqual(["c", "b"]);
    expect(drafts[0]?.command).toBe("");
  });
});

describe("criteriaChanges", () => {
  it("沒有修改時沒有任何變更", () => {
    expect(criteriaChanges(original, draftsOf(original))).toEqual({
      create: [],
      update: [],
      remove: [],
    });
    expect(criteriaDirty(original, draftsOf(original))).toBe(false);
  });

  it("新增、修改描述、刪除；空白的草稿當成刪除", () => {
    const drafts = draftsOf(original);
    const [first, second] = drafts;
    if (!first || !second) throw new Error("缺少草稿");
    const changes = criteriaChanges(original, [
      { ...first, description: "測試全部通過" },
      { ...second, description: "  " },
      { id: null, key: "new-1", kind: "manual", description: "人工確認", command: "x" },
    ]);
    expect(changes).toEqual({
      create: [{ kind: "manual", description: "人工確認", command: null, position: 1 }],
      update: [{ id: "a", input: { description: "測試全部通過" } }],
      remove: ["b"],
    });
  });

  it("改成非 command 類型時 command 一併設為 null；順序改變時更新 position", () => {
    const [first, second] = draftsOf(original);
    if (!first || !second) throw new Error("缺少草稿");
    const changes = criteriaChanges(original, [second, { ...first, kind: "agent" }]);
    expect(changes.update).toEqual([
      { id: "b", input: { position: 0 } },
      { id: "a", input: { kind: "agent", command: null, position: 1 } },
    ]);
    expect(criteriaDirty(original, [second, first])).toBe(true);
  });
});
