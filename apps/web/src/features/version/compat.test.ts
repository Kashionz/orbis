import { describe, expect, it } from "vitest";
import { zhTW } from "../../i18n/zh-TW";
import { versionNotice } from "./compat";

describe("versionNotice", () => {
  it("版本相同時沒有提示", () => {
    expect(versionNotice({ server: "0.1.0", api: 3, protocol: 2 }, 3, zhTW)).toBeNull();
  });

  it("Server 的 API 版本比 Web 新時請使用者重新整理", () => {
    expect(versionNotice({ server: "0.2.0", api: 4, protocol: 2 }, 3, zhTW)).toEqual({
      kind: "reload",
      message: "介面有新版本，請重新整理（伺服器的 API 版本 4，目前載入的是 3）",
    });
  });

  it("Server 比 Web 舊、或沒有回報版本時提示更新 Server", () => {
    expect(versionNotice({ server: "0.1.0", api: 2, protocol: 2 }, 3, zhTW)).toEqual({
      kind: "update_server",
      message: "伺服器版本過舊，請更新伺服器（伺服器 v0.1.0 的 API 版本 2，介面需要 3）",
    });
    expect(versionNotice(undefined, 3, zhTW)).toMatchObject({
      kind: "update_server",
      message: expect.stringContaining("沒有回報版本"),
    });
  });
});
