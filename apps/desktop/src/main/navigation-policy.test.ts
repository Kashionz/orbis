import { describe, expect, it } from "vitest";
import { decideNavigation, isTrustedSender } from "./navigation-policy";

const SERVER = "https://team.example.com";

describe("decideNavigation", () => {
  it("Server origin 內的網址留在 App 內", () => {
    expect(decideNavigation("https://team.example.com/tasks/ORB-1", SERVER)).toBe("allow");
    expect(decideNavigation("https://team.example.com/api/auth/github/login", SERVER)).toBe(
      "allow",
    );
  });

  it("GitHub OAuth 的登入頁留在 App 內", () => {
    expect(decideNavigation("https://github.com/login/oauth/authorize?client_id=x", SERVER)).toBe(
      "allow",
    );
    expect(decideNavigation("https://github.com/login", SERVER)).toBe("allow");
    expect(decideNavigation("https://github.com/session", SERVER)).toBe("allow");
    expect(decideNavigation("https://github.com/sessions/two-factor/app", SERVER)).toBe("allow");
  });

  it("其他 http(s) 網址用外部瀏覽器開啟", () => {
    expect(decideNavigation("https://github.com/octo/repo/pull/1", SERVER)).toBe("external");
    expect(decideNavigation("https://github.com/loginx", SERVER)).toBe("external");
    expect(decideNavigation("http://github.com/login", SERVER)).toBe("external");
    expect(decideNavigation("https://team.example.com.evil.test/", SERVER)).toBe("external");
    expect(decideNavigation("http://team.example.com/", SERVER)).toBe("external");
  });

  it("其他 scheme 與壞掉的網址一律擋下", () => {
    expect(decideNavigation("file:///C:/Windows/System32", SERVER)).toBe("deny");
    expect(decideNavigation("javascript:alert(1)", SERVER)).toBe("deny");
    expect(decideNavigation("vscode://file/x", SERVER)).toBe("deny");
    expect(decideNavigation("not a url", SERVER)).toBe("deny");
  });
});

describe("isTrustedSender", () => {
  it("只信任 Server origin 的主 frame", () => {
    expect(isTrustedSender("https://team.example.com/runs/1", true, SERVER)).toBe(true);
    expect(isTrustedSender("https://team.example.com/runs/1", false, SERVER)).toBe(false);
    expect(isTrustedSender("https://evil.test/", true, SERVER)).toBe(false);
    expect(isTrustedSender(undefined, true, SERVER)).toBe(false);
    expect(isTrustedSender("https://team.example.com/", true, null)).toBe(false);
  });
});
