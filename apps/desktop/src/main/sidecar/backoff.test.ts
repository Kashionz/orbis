import { describe, expect, it } from "vitest";
import { Backoff } from "./backoff";

describe("Backoff", () => {
  const options = { initialMs: 1_000, maxMs: 8_000, resetAfterMs: 60_000 };

  it("每次當掉加倍等待時間，直到上限", () => {
    const backoff = new Backoff(options);
    expect([0, 0, 0, 0, 0, 0].map((uptime) => backoff.next(uptime))).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
    ]);
  });

  it("連續正常運作超過 resetAfterMs 後才當掉，等待時間重置", () => {
    const backoff = new Backoff(options);
    backoff.next(0);
    backoff.next(0);
    expect(backoff.next(0)).toBe(4_000);
    expect(backoff.next(60_000)).toBe(1_000);
    expect(backoff.next(10)).toBe(2_000);
  });

  it("reset() 之後從 initialMs 重新開始", () => {
    const backoff = new Backoff(options);
    backoff.next(0);
    backoff.next(0);
    backoff.reset();
    expect(backoff.next(0)).toBe(1_000);
  });
});
