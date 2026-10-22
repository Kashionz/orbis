import { describe, expect, it } from "vitest";
import { formatTaskKey, ProjectKeyPrefix, parseTaskKey, TaskKey } from "../src/index";

describe("Task Key", () => {
  it.each(["ORB-1", "ORB-12", "AB-999999", "X1-3", "ABCDEFGHIJ-42"])("接受 %s", (key) => {
    expect(TaskKey.safeParse(key).success).toBe(true);
  });

  it.each([
    ["小寫前綴", "orb-12"],
    ["缺少流水號", "ORB-"],
    ["缺少前綴", "-12"],
    ["沒有連字號", "ORB12"],
    ["流水號為 0", "ORB-0"],
    ["流水號補零", "ORB-012"],
    ["負數流水號", "ORB--1"],
    ["一個字元的前綴", "O-1"],
    ["超過 10 個字元的前綴", "ABCDEFGHIJK-1"],
    ["數字開頭的前綴", "1RB-1"],
    ["前後有空白", " ORB-12 "],
    ["多一段", "ORB-12-3"],
  ])("拒絕%s：%s", (_, key) => {
    expect(TaskKey.safeParse(key).success).toBe(false);
  });

  it("拆出 Project 前綴與流水號", () => {
    expect(parseTaskKey("ORB-12")).toEqual({ prefix: "ORB", number: 12 });
    expect(parseTaskKey("orb-12")).toBeNull();
    expect(parseTaskKey("ORB-99999999999999999999")).toBeNull();
  });

  it("組出 Task Key，前綴或流水號不合法時丟出錯誤", () => {
    expect(formatTaskKey("ORB", 12)).toBe("ORB-12");
    expect(() => formatTaskKey("orb", 12)).toThrow();
    expect(() => formatTaskKey("ORB", 0)).toThrow();
    expect(() => formatTaskKey("ORB", 1.5)).toThrow();
  });

  it("Task Key 的前綴規則與 Project 前綴一致", () => {
    for (const prefix of ["ORB", "X1", "ABCDEFGHIJ", "orb", "O", "1RB", "ABCDEFGHIJK"]) {
      expect(TaskKey.safeParse(`${prefix}-1`).success).toBe(
        ProjectKeyPrefix.safeParse(prefix).success,
      );
    }
  });
});
