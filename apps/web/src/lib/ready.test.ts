import { describe, expect, it } from "vitest";
import { missingReadyRequirements, readyChecklist } from "./ready";

describe("readyChecklist", () => {
  it("三項都滿足時沒有缺少的項目", () => {
    const checks = readyChecklist({ repoId: "repo-1", description: "做什麼", specPath: null }, 1);
    expect(checks.every((c) => c.met)).toBe(true);
    expect(missingReadyRequirements(checks)).toEqual([]);
  });

  it("描述只有空白但有連結的 Spec 也算滿足", () => {
    const checks = readyChecklist(
      { repoId: "repo-1", description: "  \n", specPath: "docs/spec.md" },
      1,
    );
    expect(missingReadyRequirements(checks)).toEqual([]);
  });

  it("依 READY_REQUIREMENTS 的順序列出缺少的項目", () => {
    const checks = readyChecklist({ repoId: null, description: " ", specPath: null }, 0);
    expect(missingReadyRequirements(checks)).toEqual([
      "repo",
      "description",
      "acceptance_criteria",
    ]);
  });
});
