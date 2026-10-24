import { describe, expect, it } from "vitest";
import {
  checkCompatibility,
  LOCAL_VERSIONS,
  sameVerdict,
  UPDATE_BOTH_MESSAGE,
  UPDATE_DESKTOP_MESSAGE,
  UPDATE_SERVER_MESSAGE,
} from "./compat";

const local = { api: 2, protocol: 3 };
const server = (api: number, protocol: number) => ({ server: "0.2.0", api, protocol });

describe("checkCompatibility", () => {
  it("版本相同時相容", () => {
    expect(checkCompatibility(local, server(2, 3))).toEqual({ kind: "compatible" });
    expect(
      checkCompatibility(LOCAL_VERSIONS, server(LOCAL_VERSIONS.api, LOCAL_VERSIONS.protocol)),
    ).toEqual({ kind: "compatible" });
  });

  it("Server 沒有回報版本時視為 Server 過舊", () => {
    const verdict = checkCompatibility(local, undefined);
    expect(verdict.kind).toBe("update_server");
    expect(verdict).toMatchObject({ message: UPDATE_SERVER_MESSAGE });
  });

  it("Desktop 的 API 或協定版本比 Server 舊時提示更新 Desktop，並說明哪一個版本", () => {
    expect(checkCompatibility(local, server(3, 3))).toEqual({
      kind: "update_desktop",
      message: UPDATE_DESKTOP_MESSAGE,
      detail: "Desktop 的API 版本 2，Server 需要 3（Server v0.2.0）。",
    });
    expect(checkCompatibility(local, server(2, 4))).toMatchObject({
      kind: "update_desktop",
      detail: expect.stringContaining("協定版本 3，Server 需要 4"),
    });
  });

  it("Server 比 Desktop 舊時提示更新 Server", () => {
    expect(checkCompatibility(local, server(1, 3))).toMatchObject({
      kind: "update_server",
      message: UPDATE_SERVER_MESSAGE,
      detail: expect.stringContaining("Server 的API 版本 1，Desktop 需要 2"),
    });
    expect(checkCompatibility(local, server(2, 1)).kind).toBe("update_server");
  });

  it("一邊的 API 較舊、另一邊的協定較舊時兩者都要更新", () => {
    expect(checkCompatibility(local, server(3, 1))).toMatchObject({
      kind: "update_both",
      message: UPDATE_BOTH_MESSAGE,
    });
  });
});

describe("sameVerdict", () => {
  it("同一種問題視為相同，細節不同視為不同", () => {
    const a = checkCompatibility(local, server(3, 3));
    expect(sameVerdict(a, checkCompatibility(local, server(3, 3)))).toBe(true);
    expect(sameVerdict(a, checkCompatibility(local, server(4, 3)))).toBe(false);
    expect(sameVerdict(a, checkCompatibility(local, server(1, 3)))).toBe(false);
    expect(sameVerdict({ kind: "compatible" }, { kind: "compatible" })).toBe(true);
    expect(sameVerdict(null, { kind: "compatible" })).toBe(false);
    expect(sameVerdict(null, null)).toBe(true);
  });
});
