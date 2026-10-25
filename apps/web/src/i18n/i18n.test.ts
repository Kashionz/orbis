import { describe, expect, it } from "vitest";
import { en } from "./en";
import { zhTW } from "./zh-TW";

/** 把字典攤平成 `key → 型別` 的清單（函式記下參數個數）。 */
function shape(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [`${prefix}:string`];
  if (typeof value === "function") return [`${prefix}:fn/${value.length}`];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      shape(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [`${prefix}:${typeof value}`];
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("i18n 字典", () => {
  it("en 與 zh-TW 有相同的 key 與函式參數個數", () => {
    expect(shape(en).sort()).toEqual(shape(zhTW).sort());
  });

  it("沒有空字串", () => {
    expect(strings(zhTW).filter((s) => s.trim() === "")).toEqual([]);
    expect(strings(en).filter((s) => s.trim() === "")).toEqual([]);
  });

  it("不用「·」當分隔符", () => {
    expect(strings(zhTW).filter((s) => s.includes("·"))).toEqual([]);
    expect(strings(en).filter((s) => s.includes("·"))).toEqual([]);
  });

  it("zh-TW 的說明文字不用「你」（成員列標示自己的「（你）」除外）", () => {
    const { youSuffix: _, ...share } = zhTW.share;
    expect(strings({ ...zhTW, share }).filter((s) => s.includes("你"))).toEqual([]);
  });

  it("函式項目產生的文字帶入參數", () => {
    expect(zhTW.common.minutesAgo(3)).toBe("3 分鐘前");
    expect(en.common.minutesAgo(3)).toBe("3m ago");
  });
});
