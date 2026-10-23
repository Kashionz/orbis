// Run 分支名稱的 slug（#54）：保留中文等 Unicode 字母與數字，過濾 git 不允許的字元。

import { execFileSync } from "node:child_process";
import { NAMES } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import { branchName, branchSlug } from "../src/runner/dispatcher";

describe("branchSlug", () => {
  it("英文標題：小寫，非字母數字換成 -", () => {
    expect(branchSlug("Fix Login Bug!")).toBe("fix-login-bug");
  });

  it("中文標題保留原字，不做音譯", () => {
    expect(branchSlug("修正登入流程")).toBe("修正登入流程");
    expect(branchSlug("新增 Plan Gate 的 API")).toBe("新增-plan-gate-的-api");
  });

  it("NFKC 正規化：全形英數轉成半形", () => {
    expect(branchSlug("ＡＢＣ１２３")).toBe("abc123");
  });

  it("過濾 git 不允許的 ..、@{、結尾 .lock、控制字元與空白", () => {
    expect(branchSlug("a..b")).toBe("a-b");
    expect(branchSlug("x@{1}")).toBe("x-1");
    expect(branchSlug("release.lock")).toBe("release-lock");
    expect(branchSlug("tab\there\u0007bell")).toBe("tab-here-bell");
    expect(branchSlug("~^:?*[\\]")).toBe("task");
  });

  it("最多 40 個字元（以字元計），截斷後不留結尾的 -", () => {
    expect(Array.from(branchSlug("中".repeat(60)))).toHaveLength(40);
    expect(branchSlug(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
    // 補充平面的字元不會被切成一半。
    expect(branchSlug("𠀀".repeat(41))).toBe("𠀀".repeat(40));
  });

  it("全是符號或空白時退回 task", () => {
    expect(branchSlug("")).toBe("task");
    expect(branchSlug("!!! ---")).toBe("task");
  });
});

describe("branchName", () => {
  it("組成 <前綴><Task Key>-<slug>，第 2 個以後的 Run 加 -r<序號>", () => {
    expect(branchName("SBX-1", "修正登入流程", 1)).toBe(`${NAMES.branchPrefix}SBX-1-修正登入流程`);
    expect(branchName("ORB-2", "Plan", 3)).toBe(`${NAMES.branchPrefix}ORB-2-plan-r3`);
  });

  it("git check-ref-format 接受產生的分支名稱", () => {
    for (const title of ["修正登入流程", "a..b@{c}.lock", "日本語のタイトル", "Émoji 🎉 test"]) {
      const name = branchName("ORB-12", title, 2);
      expect(() => execFileSync("git", ["check-ref-format", "--branch", name])).not.toThrow();
    }
  });
});
