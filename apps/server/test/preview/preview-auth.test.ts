// Preview 網址的網域解析與換票（ARCHITECTURE §13），不需要 DB。

import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/clock";
import { CONFIG_ENV, ConfigError, loadConfig } from "../../src/config";
import { ACCESS_CACHE_MS, PreviewAuth, TICKET_TTL_MS } from "../../src/preview/auth";
import {
  PREVIEW_COOKIE,
  parsePreviewDomain,
  previewShareUrl,
  runIdFromHost,
  safeReturnPath,
} from "../../src/preview/domain";
import { withoutPreviewCookie } from "../../src/preview/host";

const RUN = "0192f0c4-7a1b-7c3d-8e9f-0a1b2c3d4e5f";
const OTHER_RUN = "0192f0c4-7a1b-7c3d-8e9f-0a1b2c3d4e60";

describe("Preview 網域", () => {
  it("scheme 跟 Web UI 相同，Preview 網址是 <run-id>.<Preview 網域>", () => {
    const https = parsePreviewDomain("Preview.Example.com", "https://orbis.example.com");
    expect(https).toEqual({ scheme: "https", host: "preview.example.com" });
    expect(https && previewShareUrl(RUN, https)).toBe(`https://${RUN}.preview.example.com/`);
    const dev = parsePreviewDomain("preview.localhost:4500", "http://localhost:5173");
    expect(dev && previewShareUrl(RUN, dev)).toBe(`http://${RUN}.preview.localhost:4500/`);
  });

  it("沒有設定時不提供 Preview 網址", () => {
    expect(parsePreviewDomain(null, "https://x")).toBeNull();
    expect(parsePreviewDomain("", "https://x")).toBeNull();
  });

  it("由 Host 找出 Run：只接受 Preview 網域底下、以 Run ID 為標籤的 host", () => {
    const domain = parsePreviewDomain("preview.example.com", "https://orbis.example.com");
    expect(runIdFromHost(`${RUN}.preview.example.com`, domain)).toBe(RUN);
    expect(runIdFromHost(`${RUN.toUpperCase()}.PREVIEW.example.com:443`, domain)).toBe(RUN);
    expect(runIdFromHost("preview.example.com", domain)).toBeNull();
    expect(runIdFromHost("orbis.example.com", domain)).toBeNull();
    expect(runIdFromHost(`x.${RUN}.preview.example.com`, domain)).toBeNull();
    expect(runIdFromHost(`${RUN}.preview.example.com.evil.test`, domain)).toBeNull();
    expect(runIdFromHost(`${RUN}.preview.example.com:8443`, domain)).toBeNull();
    expect(runIdFromHost(`${RUN}.preview.example.com`, null)).toBeNull();
  });

  it("導回的路徑只能是同一個 origin 內的路徑", () => {
    expect(safeReturnPath("/a/b?c=1")).toBe("/a/b?c=1");
    expect(safeReturnPath("//evil.test/")).toBe("/");
    expect(safeReturnPath("/\\evil.test/")).toBe("/");
    expect(safeReturnPath("https://evil.test/")).toBe("/");
    expect(safeReturnPath(null)).toBe("/");
    // 瀏覽器會去掉 tab、換行，或把反斜線當成斜線，這些都可能變成 `//evil.test`
    for (const tricky of [
      "/\t/evil.test",
      "/\n/evil.test",
      "/\r//evil.test",
      "\\evil.test",
      "/a\\b",
    ]) {
      expect(safeReturnPath(tricky), JSON.stringify(tricky)).toBe("/");
    }
    // URL 解析會正規化路徑，正規化後的結果也要檢查
    for (const dotted of ["/.//evil.test", "/%2e//evil.test", "/a/..//evil.test", "/./../evil"]) {
      const result = safeReturnPath(dotted);
      expect(result.startsWith("//"), `${dotted} → ${result}`).toBe(false);
    }
    expect(safeReturnPath("/a b?q=中文#x")).toBe("/a%20b?q=%E4%B8%AD%E6%96%87#x");
  });

  it("設定值必須是網域，不含 scheme 與路徑", () => {
    const base = {
      [CONFIG_ENV.databaseUrl]: "postgres://u:p@localhost/db",
      [CONFIG_ENV.githubClientId]: "id",
      [CONFIG_ENV.githubClientSecret]: "secret",
    };
    const withDomain = (value: string) => ({ ...base, [CONFIG_ENV.previewDomain]: value });
    expect(loadConfig(base).previewDomain).toBeNull();
    expect(loadConfig(withDomain("preview.example.com")).previewDomain).toBe("preview.example.com");
    for (const bad of ["https://preview.example.com", "preview.example.com/x", "bad_domain"]) {
      expect(() => loadConfig(withDomain(bad)), bad).toThrow(ConfigError);
    }
  });
});

describe("PreviewAuth", () => {
  function setup(canView = true) {
    const clock = new ManualClock(new Date("2026-10-23T08:00:00.000Z"));
    const checks: string[] = [];
    let allowed = canView;
    const auth = new PreviewAuth(clock, async (sessionId, runId) => {
      checks.push(`${sessionId}:${runId}`);
      return allowed;
    });
    return { clock, auth, checks, revoke: () => (allowed = false) };
  }

  it("ticket 只能用一次，換成這個 Run 的 preview session", async () => {
    const { auth } = setup();
    const ticket = auth.issueTicket(RUN, "session-1");
    const cookie = auth.redeemTicket(ticket, RUN);
    expect(cookie).toBeTruthy();
    expect(auth.redeemTicket(ticket, RUN)).toBeNull();
    expect(await auth.check(cookie ?? undefined, RUN)).toBe(true);
    // 其他 Run 的 Preview 不能用
    expect(await auth.check(cookie ?? undefined, OTHER_RUN)).toBe(false);
    expect(await auth.check("forged", RUN)).toBe(false);
    expect(await auth.check(undefined, RUN)).toBe(false);
  });

  it("ticket 綁定 Run，而且 60 秒後失效", () => {
    const { auth, clock } = setup();
    expect(auth.redeemTicket(auth.issueTicket(RUN, "s"), OTHER_RUN)).toBeNull();
    const ticket = auth.issueTicket(RUN, "s");
    clock.advance(TICKET_TTL_MS);
    expect(auth.redeemTicket(ticket, RUN)).toBeNull();
  });

  it("每 5 秒重新確認登入的 session 與查看權限，失效後 preview session 也失效", async () => {
    const { auth, clock, checks, revoke } = setup();
    const cookie = auth.redeemTicket(auth.issueTicket(RUN, "session-1"), RUN) ?? undefined;
    expect(await auth.check(cookie, RUN)).toBe(true);
    expect(checks).toEqual([]);
    clock.advance(ACCESS_CACHE_MS);
    expect(await auth.check(cookie, RUN)).toBe(true);
    expect(checks).toEqual([`session-1:${RUN}`]);
    revoke();
    clock.advance(ACCESS_CACHE_MS - 1);
    expect(await auth.check(cookie, RUN)).toBe(true);
    clock.advance(1);
    expect(await auth.check(cookie, RUN)).toBe(false);
    revoke();
    expect(await auth.check(cookie, RUN)).toBe(false);
  });
});

describe("轉送前移除 preview cookie", () => {
  it("只移除 Server 自己的 preview cookie，其他 cookie 留給 dev server", () => {
    expect(withoutPreviewCookie(`a=1; ${PREVIEW_COOKIE}=secret; b=2`)).toBe("a=1; b=2");
    expect(withoutPreviewCookie(`${PREVIEW_COOKIE}=secret`)).toBeNull();
    expect(withoutPreviewCookie(null)).toBeNull();
  });
});
