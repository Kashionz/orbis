import { StoppedRunInfo } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import { legacyStoppedRunInfo, stoppedRunInfo } from "../src/http/dto";

describe("Needs You 的 stopped_run 原因", () => {
  it("有 reasonCode 時原樣使用", () => {
    expect(
      stoppedRunInfo({ reason: "x", reasonCode: "push_failed", attempt: null, detail: "denied" }),
    ).toEqual({ reasonCode: "push_failed", attempt: null, detail: "denied" });
    expect(stoppedRunInfo({ reasonCode: "verification_limit", attempt: 4, detail: null })).toEqual({
      reasonCode: "verification_limit",
      attempt: 4,
      detail: null,
    });
  });

  it("migration 0004 之前的原因文字：依前綴推回代碼，冒號後面是 detail", () => {
    expect(stoppedRunInfo({ reason: "Verification 連續失敗 4 次", verificationId: "v1" })).toEqual({
      reasonCode: "verification_limit",
      attempt: 4,
      detail: null,
    });
    expect(legacyStoppedRunInfo("開 PR 失敗：GitHub 回應 502", false)).toEqual({
      reasonCode: "pr_open_failed",
      attempt: null,
      detail: "GitHub 回應 502",
    });
    expect(legacyStoppedRunInfo("push 分支失敗：remote: Permission denied", false)).toEqual({
      reasonCode: "push_failed",
      attempt: null,
      detail: "remote: Permission denied",
    });
    expect(legacyStoppedRunInfo("push 分支失敗", false)).toEqual({
      reasonCode: "push_failed",
      attempt: null,
      detail: null,
    });
  });

  it("解析不到 Verification 的次數時 attempt 為 null，不給錯的數字", () => {
    expect(legacyStoppedRunInfo("Verification 失敗", true)).toEqual({
      reasonCode: "verification_limit",
      attempt: null,
      detail: null,
    });
  });

  it("新資料符合契約", () => {
    for (const info of [
      stoppedRunInfo({ reasonCode: "verification_limit", attempt: 2, detail: null }),
      legacyStoppedRunInfo("開 PR 失敗：GitHub 回應 502", false),
    ]) {
      expect(StoppedRunInfo.safeParse(info).success).toBe(true);
    }
  });
});
