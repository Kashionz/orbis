import { describe, expect, it } from "vitest";
import { RELOAD_MESSAGE, UPDATE_SERVER_MESSAGE, versionNotice } from "./compat";

describe("versionNotice", () => {
  it("版本相同時沒有提示", () => {
    expect(versionNotice({ server: "0.1.0", api: 3, protocol: 2 }, 3)).toBeNull();
  });

  it("Server 的 API 版本比 Web 新時請使用者重新整理", () => {
    expect(versionNotice({ server: "0.2.0", api: 4, protocol: 2 }, 3)).toEqual({
      kind: "reload",
      message: `${RELOAD_MESSAGE}（Server 的 API 版本 4，目前載入的是 3）`,
    });
  });

  it("Server 比 Web 舊、或沒有回報版本時提示更新 Server", () => {
    expect(versionNotice({ server: "0.1.0", api: 2, protocol: 2 }, 3)).toMatchObject({
      kind: "update_server",
      message: expect.stringContaining(UPDATE_SERVER_MESSAGE),
    });
    expect(versionNotice(undefined, 3)).toMatchObject({
      kind: "update_server",
      message: expect.stringContaining("沒有回報版本"),
    });
  });
});
