import { describe, expect, it } from "vitest";
import { duration, relativeTime, type TimeWords } from "./time-format";

const words: TimeWords = {
  justNow: "剛剛",
  minutesAgo: (n) => `${n} 分鐘前`,
  hoursAgo: (n) => `${n} 小時前`,
  daysAgo: (n) => `${n} 天前`,
  durationSeconds: (s) => `${s}s`,
  durationMinutes: (m, s) => `${m}m ${s}s`,
  durationHours: (h, m) => `${h}h ${m}m`,
};

describe("relativeTime", () => {
  const now = Date.parse("2026-10-25T08:00:00Z");
  const before = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it("一分鐘內是剛剛，之後依分鐘、小時、天", () => {
    expect(relativeTime(before(30), now, words)).toBe("剛剛");
    expect(relativeTime(before(125), now, words)).toBe("2 分鐘前");
    expect(relativeTime(before(3 * 3600 + 5), now, words)).toBe("3 小時前");
    expect(relativeTime(before(2 * 86_400), now, words)).toBe("2 天前");
  });

  it("未來的時間（時鐘誤差）當成剛剛", () => {
    expect(relativeTime(before(-20), now, words)).toBe("剛剛");
  });
});

describe("duration", () => {
  it("秒、分秒、時分，至少 1 秒", () => {
    expect(duration(0, words)).toBe("1s");
    expect(duration(42, words)).toBe("42s");
    expect(duration(192, words)).toBe("3m 12s");
    expect(duration(3900, words)).toBe("1h 5m");
  });
});
