import { describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { zhTW } from "../i18n/zh-TW";
import { formatDuration, formatRelativeTime, formatUsage } from "./format";

const NOW = Date.parse("2026-10-25T12:00:00Z");

describe("formatRelativeTime", () => {
  it("一分鐘內是剛剛，之後依分鐘、小時、天", () => {
    expect(formatRelativeTime(NOW - 30_000, NOW, zhTW)).toBe("剛剛");
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW, zhTW)).toBe("5 分鐘前");
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW, zhTW)).toBe("3 小時前");
    expect(formatRelativeTime("2026-10-23T12:00:00Z", NOW, zhTW)).toBe("2 天前");
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW, en)).toBe("5m ago");
  });
});

describe("formatDuration", () => {
  it("秒、分秒、時分", () => {
    expect(formatDuration(45, zhTW)).toBe("45s");
    expect(formatDuration(192, zhTW)).toBe("3m 12s");
    expect(formatDuration(3_900, zhTW)).toBe("1h 5m");
  });
});

describe("formatUsage", () => {
  it("不用「·」當分隔符", () => {
    const text = formatUsage(
      {
        inputTokens: null,
        outputTokens: 400,
        thoughtTokens: null,
        cachedReadTokens: null,
        cachedWriteTokens: null,
        contextUsedTokens: 1_200,
        contextWindowTokens: 200_000,
        cost: { amount: 0.0125, currency: "USD" },
      },
      zhTW,
    );
    expect(text).toBe("上下文 1,200 / 200,000   輸出 400   USD 0.0125");
    expect(text).not.toContain("·");
  });
});
