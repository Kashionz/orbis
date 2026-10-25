import { describe, expect, it } from "vitest";
import {
  type ComposerSituation,
  dockFor,
  type SendCapabilities,
  sendStateFor,
} from "./composer-state";

const base: ComposerSituation = {
  status: "running",
  gate: null,
  pendingPermission: null,
  planGatePending: false,
  reviewGatePending: false,
  verificationAwaitingDecision: false,
};
const all: SendCapabilities = { reject: true, control: true, prompt: true };
const permission = { key: "permission-p1", title: "執行指令", detail: "pnpm test" };
const reviewGate: ComposerSituation = {
  ...base,
  status: "awaiting_gate",
  gate: "review",
  reviewGatePending: true,
};
const planGate: ComposerSituation = {
  ...base,
  status: "awaiting_gate",
  gate: "plan",
  planGatePending: true,
};

describe("dockFor", () => {
  it("執行中沒有待處理的動作時不顯示", () => {
    expect(dockFor(base)).toBeNull();
  });

  it("權限請求優先於其他動作", () => {
    expect(dockFor({ ...reviewGate, pendingPermission: permission })).toEqual({
      kind: "permission",
      permission,
    });
  });

  it("審查關卡只在停在 Review Gate 時顯示，Verification 進行中不顯示", () => {
    expect(dockFor(reviewGate)).toEqual({ kind: "review_gate" });
    expect(dockFor({ ...reviewGate, status: "verifying", gate: null })).toBeNull();
  });

  it("計畫關卡與驗收的決定", () => {
    expect(dockFor(planGate)).toEqual({ kind: "plan_gate" });
    expect(dockFor({ ...base, status: "verifying", verificationAwaitingDecision: true })).toEqual({
      kind: "verification_decision",
    });
  });
});

describe("sendStateFor", () => {
  it("Run 結束後停用", () => {
    for (const status of ["completed", "failed", "canceled"] as const) {
      expect(sendStateFor({ ...base, status }, all)).toEqual({
        action: "prompt",
        blocker: "finished",
      });
    }
  });

  it("Gate 與 Verification 的決定依狀態決定，沒有權限時不能送出", () => {
    expect(sendStateFor(planGate, all)).toEqual({ action: "plan_reject", blocker: null });
    expect(sendStateFor(reviewGate, all)).toEqual({ action: "review_reject", blocker: null });
    expect(
      sendStateFor({ ...base, status: "verifying", verificationAwaitingDecision: true }, all),
    ).toEqual({ action: "verification_retry", blocker: null });
    expect(sendStateFor(reviewGate, { ...all, reject: false })).toEqual({
      action: "review_reject",
      blocker: "forbidden",
    });
  });

  it("執行中傳訊息：後端不支援時標示尚未開放", () => {
    expect(sendStateFor(base, all)).toEqual({ action: "prompt", blocker: null });
    expect(sendStateFor(base, { ...all, prompt: false })).toEqual({
      action: "prompt",
      blocker: "unavailable",
    });
    expect(sendStateFor(base, { ...all, control: false })).toEqual({
      action: "prompt",
      blocker: "forbidden",
    });
  });
});
