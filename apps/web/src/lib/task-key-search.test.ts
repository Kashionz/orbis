import { describe, expect, it } from "vitest";
import { matchesTaskKey, parseTaskKeyQuery } from "./task-key-search";

const keys = ["ORB-1", "ORB-12", "ORB-120", "DOC-12"];
const search = (input: string) =>
  keys.filter((key) => matchesTaskKey(key, parseTaskKeyQuery(input)));

describe("Task Key 搜尋", () => {
  it("空白輸入不過濾", () => {
    expect(search("  ")).toEqual(keys);
  });

  it("完整的 Task Key 只比對同一個（不分大小寫）", () => {
    expect(search("orb-12")).toEqual(["ORB-12"]);
    expect(parseTaskKeyQuery("ORB-12")?.exact).toBe(true);
  });

  it("只輸入數字時比對流水號", () => {
    expect(search("12")).toEqual(["ORB-12", "DOC-12"]);
  });

  it("不完整的輸入比對開頭", () => {
    expect(search("ORB")).toEqual(["ORB-1", "ORB-12", "ORB-120"]);
    expect(search("ORB-")).toEqual(["ORB-1", "ORB-12", "ORB-120"]);
    expect(parseTaskKeyQuery("ORB-")?.exact).toBe(false);
  });

  it("沒有符合的 Task", () => {
    expect(search("XYZ-1")).toEqual([]);
  });
});
