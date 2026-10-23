import { describe, expect, it } from "vitest";
import { appInstallUrl } from "./github";

const INSTALL_URL = "https://github.com/apps/example/installations/new";

describe("appInstallUrl", () => {
  it("還沒安裝時回傳安裝連結", () => {
    expect(appInstallUrl({ github: { installed: false, installUrl: INSTALL_URL } })).toBe(
      INSTALL_URL,
    );
  });

  it("已安裝時沒有連結", () => {
    expect(appInstallUrl({ github: { installed: true, installUrl: INSTALL_URL } })).toBeNull();
  });

  it("Server 沒有設定 GitHub App（installUrl 是 null）時沒有連結", () => {
    expect(appInstallUrl({ github: { installed: false, installUrl: null } })).toBeNull();
  });

  it("不是 https 的網址不當成連結", () => {
    for (const installUrl of ["javascript:alert(1)", "http://example.com/install", "不是網址"]) {
      expect(appInstallUrl({ github: { installed: false, installUrl } })).toBeNull();
    }
  });
});
