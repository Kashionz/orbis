import { NAMES, type RunUsage } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import {
  contextUsage,
  elapsedMs,
  formatCost,
  formatElapsed,
  formatTokens,
  shortenPath,
} from "./run-meter";

const usage = (patch: Partial<RunUsage>): RunUsage => ({
  inputTokens: null,
  outputTokens: null,
  thoughtTokens: null,
  cachedReadTokens: null,
  cachedWriteTokens: null,
  contextUsedTokens: null,
  contextWindowTokens: null,
  cost: null,
  ...patch,
});

describe("經過時間", () => {
  it("不到一小時為 mm:ss，之後為 h:mm:ss", () => {
    expect(formatElapsed(65_000)).toBe("01:05");
    expect(formatElapsed((38 * 60 + 12) * 1000)).toBe("38:12");
    expect(formatElapsed((3600 + 2 * 60 + 3) * 1000)).toBe("1:02:03");
  });

  it("結束後停在結束時間，還沒開始時為 null", () => {
    const start = "2026-10-25T08:00:00.000Z";
    expect(elapsedMs(start, "2026-10-25T08:01:00.000Z", Date.parse(start) + 999_999)).toBe(60_000);
    expect(elapsedMs(start, null, Date.parse(start) + 5_000)).toBe(5_000);
    expect(elapsedMs(null, null, 0)).toBeNull();
  });
});

describe("context 用量與費用", () => {
  it("百分比、超過 80% 警告、短格式的明細", () => {
    expect(
      contextUsage(usage({ contextUsedTokens: 41_880, contextWindowTokens: 200_000 })),
    ).toEqual({ percent: 21, warn: false, detail: "41.9k / 200.0k" });
    expect(
      contextUsage(usage({ contextUsedTokens: 170_000, contextWindowTokens: 200_000 }))?.warn,
    ).toBe(true);
    expect(contextUsage(usage({ contextUsedTokens: 10 }))).toBeNull();
  });

  it("token 數與費用的格式", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatCost(usage({ cost: { amount: 0.3184, currency: "USD" } }))).toBe("$0.32");
    expect(formatCost(usage({}))).toBeNull();
  });
});

describe("shortenPath", () => {
  it("家目錄換成 ~，保留分隔符號", () => {
    const dir = NAMES.configDir;
    expect(shortenPath(`C:\\Users\\kash\\${dir}\\wt\\ORB-42`)).toBe(`~\\${dir}\\wt\\ORB-42`);
    expect(shortenPath(`/Users/kash/${dir}/wt/ORB-42`)).toBe(`~/${dir}/wt/ORB-42`);
    expect(shortenPath("/home/kash/wt")).toBe("~/wt");
    expect(shortenPath("D:\\work\\wt")).toBe("D:\\work\\wt");
  });
});
