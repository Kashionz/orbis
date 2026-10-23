// 通知系統（ARCHITECTURE §12.3）：勿擾時段、依事件類型關閉、Channel。

import { describe, expect, it } from "vitest";
import {
  isInQuietHours,
  isValidTimeZone,
  localMinuteOfDay,
} from "../src/notifications/quiet-hours";

const at = (iso: string) => new Date(iso);

describe("勿擾時段", () => {
  it("以本人的時區計算當地時間", () => {
    // 2026-10-23T14:30Z 是台北的 22:30、紐約（夏令時間）的 10:30。
    expect(localMinuteOfDay(at("2026-10-23T14:30:00Z"), "Asia/Taipei")).toBe(22 * 60 + 30);
    expect(localMinuteOfDay(at("2026-10-23T14:30:00Z"), "America/New_York")).toBe(10 * 60 + 30);
  });

  it("同一天內的時段：含開始、不含結束", () => {
    const quiet = { startMinute: 12 * 60, endMinute: 13 * 60, timeZone: "UTC" };
    expect(isInQuietHours(at("2026-10-23T11:59:00Z"), quiet)).toBe(false);
    expect(isInQuietHours(at("2026-10-23T12:00:00Z"), quiet)).toBe(true);
    expect(isInQuietHours(at("2026-10-23T12:59:00Z"), quiet)).toBe(true);
    expect(isInQuietHours(at("2026-10-23T13:00:00Z"), quiet)).toBe(false);
  });

  it("跨午夜的時段（22:00–07:00，台北）", () => {
    const quiet = { startMinute: 22 * 60, endMinute: 7 * 60, timeZone: "Asia/Taipei" };
    expect(isInQuietHours(at("2026-10-23T13:59:00Z"), quiet)).toBe(false); // 21:59
    expect(isInQuietHours(at("2026-10-23T14:00:00Z"), quiet)).toBe(true); // 22:00
    expect(isInQuietHours(at("2026-10-23T18:00:00Z"), quiet)).toBe(true); // 02:00
    expect(isInQuietHours(at("2026-10-23T22:59:00Z"), quiet)).toBe(true); // 06:59
    expect(isInQuietHours(at("2026-10-23T23:00:00Z"), quiet)).toBe(false); // 07:00
  });

  it("沒有設定、或開始與結束相同時不算勿擾", () => {
    expect(isInQuietHours(at("2026-10-23T12:00:00Z"), null)).toBe(false);
    expect(
      isInQuietHours(at("2026-10-23T12:00:00Z"), {
        startMinute: 600,
        endMinute: 600,
        timeZone: "UTC",
      }),
    ).toBe(false);
  });

  it("檢查時區名稱", () => {
    expect(isValidTimeZone("Asia/Taipei")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});
