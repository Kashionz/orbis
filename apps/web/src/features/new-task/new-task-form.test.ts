import { describe, expect, it } from "vitest";
import {
  canCreate,
  filledCriteria,
  missingRequirements,
  type NewTaskForm,
  newCriterion,
  nextTaskKey,
} from "./new-task-form";

function form(overrides: Partial<NewTaskForm> = {}): NewTaskForm {
  return {
    title: "修正換行",
    description: "",
    repoId: "repo-1",
    assigneeMemberId: null,
    dependsOn: null,
    criteria: [newCriterion("command")],
    ...overrides,
  };
}

describe("missingRequirements", () => {
  it("列出缺少的描述與驗收條件（空白的條件不算）", () => {
    expect(missingRequirements(form())).toEqual(["description", "acceptance_criteria"]);
  });

  it("沒有指定 Repo 時也列出", () => {
    expect(missingRequirements(form({ repoId: null }))[0]).toBe("repo");
  });

  it("齊備時沒有缺少的項目", () => {
    const criterion = { ...newCriterion("agent"), description: "換行後顯示正確" };
    expect(missingRequirements(form({ description: "說明", criteria: [criterion] }))).toEqual([]);
  });
});

describe("表單", () => {
  it("沒有標題時不能建立", () => {
    expect(canCreate({ title: "  " })).toBe(false);
    expect(canCreate({ title: "x" })).toBe(true);
  });

  it("只送出有描述的條件", () => {
    const filled = { ...newCriterion("manual"), description: "人工確認" };
    expect(filledCriteria({ criteria: [newCriterion("command"), filled] })).toEqual([filled]);
  });

  it("每個新條件有不同的 id", () => {
    expect(newCriterion("agent").id).not.toBe(newCriterion("agent").id);
  });
});

describe("nextTaskKey", () => {
  it("是 Project 中最大的編號加一", () => {
    expect(nextTaskKey("ORB", [{ key: "ORB-2" }, { key: "ORB-41" }, { key: "ORB-7" }])).toBe(
      "ORB-42",
    );
    expect(nextTaskKey("ORB", [])).toBe("ORB-1");
  });

  it("忽略其他前綴的 Key", () => {
    expect(nextTaskKey("WEB", [{ key: "ORB-9" }, { key: "WEB-3" }])).toBe("WEB-4");
  });
});
