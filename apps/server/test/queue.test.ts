// 並行與佇列（ARCHITECTURE §7）：Credential 的並行上限（預設 30）、Admin 的覆寫、rate limit 期間不派工。

import { describe, expect, it } from "vitest";
import {
  credentialCapacity,
  DEFAULT_CREDENTIAL_CONCURRENCY,
  effectiveMaxConcurrency,
} from "../src/runner/capacity";

const now = new Date("2026-10-23T08:00:00Z");

describe("Credential 的並行上限", () => {
  it("有效上限＝Admin 的覆寫 ?? Runner 回報 ?? 預設 30", () => {
    expect(DEFAULT_CREDENTIAL_CONCURRENCY).toBe(30);
    expect(effectiveMaxConcurrency(5, 30)).toBe(5);
    expect(effectiveMaxConcurrency(null, 12)).toBe(12);
    expect(effectiveMaxConcurrency(null, null)).toBe(30);
  });

  it("進行中的 Run 達到上限時排隊", () => {
    const load = { maxConcurrency: 2, rateLimitedUntil: null };
    expect(credentialCapacity({ ...load, active: 1 }, now)).toEqual({ ok: true });
    expect(credentialCapacity({ ...load, active: 2 }, now)).toEqual({
      ok: false,
      reason: "concurrency_limit",
    });
  });

  it("rate limit 恢復前不派新的 Run，恢復後照常", () => {
    const limited = {
      maxConcurrency: 30,
      active: 0,
      rateLimitedUntil: new Date("2026-10-23T08:05:00Z"),
    };
    expect(credentialCapacity(limited, now)).toEqual({ ok: false, reason: "rate_limited" });
    expect(credentialCapacity(limited, new Date("2026-10-23T08:05:00Z"))).toEqual({ ok: true });
  });
});
