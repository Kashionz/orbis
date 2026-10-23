import { describe, expect, it } from "vitest";
import { validateProjectForm, validateRepoForm } from "./project-forms";

describe("validateProjectForm", () => {
  it("通過時回傳要送出的輸入：名稱去掉空白、前綴轉成大寫", () => {
    expect(
      validateProjectForm({ name: "  核心產品 ", keyPrefix: " orb ", description: "說明" }),
    ).toEqual({ ok: true, input: { name: "核心產品", keyPrefix: "ORB", description: "說明" } });
  });

  it("名稱不能是空白", () => {
    const result = validateProjectForm({ name: "   ", keyPrefix: "ORB", description: "" });
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.errors)).toEqual(["name"]);
  });

  it.each([
    ["太短", "O"],
    ["太長", "ABCDEFGHIJK"],
    ["數字開頭", "1AB"],
    ["有符號", "OR-B"],
  ])("Task Key 前綴不符合規則（%s）時顯示契約的說明", (_case, keyPrefix) => {
    const result = validateProjectForm({ name: "核心產品", keyPrefix, description: "" });
    expect(result).toEqual({
      ok: false,
      errors: { keyPrefix: "Project 前綴必須是 2–10 個大寫英文字母或數字，並以字母開頭" },
    });
  });

  it("每個有問題的欄位都列出", () => {
    const result = validateProjectForm({ name: "", keyPrefix: "", description: "" });
    expect(!result.ok && Object.keys(result.errors).sort()).toEqual(["keyPrefix", "name"]);
  });
});

describe("validateRepoForm", () => {
  it("default branch 留空時不送", () => {
    expect(validateRepoForm({ owner: " acme ", name: "demo", defaultBranch: "  " })).toEqual({
      ok: true,
      input: { owner: "acme", name: "demo" },
    });
  });

  it("有填 default branch 時一起送", () => {
    expect(validateRepoForm({ owner: "acme", name: "demo", defaultBranch: "develop" })).toEqual({
      ok: true,
      input: { owner: "acme", name: "demo", defaultBranch: "develop" },
    });
  });

  it("owner、name 不合法時標在對應的欄位", () => {
    const result = validateRepoForm({ owner: "-acme", name: "..", defaultBranch: "" });
    expect(result).toEqual({
      ok: false,
      errors: {
        owner: "不是合法的 GitHub 使用者或組織名稱",
        name: "不是合法的 GitHub repository 名稱",
      },
    });
  });

  it("不合法的分支名稱", () => {
    const result = validateRepoForm({ owner: "acme", name: "demo", defaultBranch: "a..b" });
    expect(result).toEqual({ ok: false, errors: { defaultBranch: "不是合法的 git 分支名稱" } });
  });
});
