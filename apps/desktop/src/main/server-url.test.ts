import { describe, expect, it } from "vitest";
import { checkServerHealth, normalizeServerUrl } from "./server-url";

describe("normalizeServerUrl", () => {
  it("只保留 origin，去掉結尾斜線，沒有 scheme 時補 https", () => {
    expect(normalizeServerUrl(" https://example.com/ ")).toEqual({
      ok: true,
      url: "https://example.com",
    });
    expect(normalizeServerUrl("http://localhost:5173")).toEqual({
      ok: true,
      url: "http://localhost:5173",
    });
    expect(normalizeServerUrl("example.com:8443")).toEqual({
      ok: true,
      url: "https://example.com:8443",
    });
    expect(normalizeServerUrl("HTTPS://Example.COM")).toEqual({
      ok: true,
      url: "https://example.com",
    });
  });

  it("拒絕空白、其他 scheme、路徑、帳密與 query", () => {
    for (const input of [
      "",
      "   ",
      "ftp://example.com",
      "file:///C:/x",
      "javascript://alert(1)",
      "https://example.com/app",
      "https://user:pw@example.com",
      "https://example.com/?a=1",
      "https://",
    ]) {
      expect(normalizeServerUrl(input).ok, input).toBe(false);
    }
  });
});

describe("checkServerHealth", () => {
  const respond = (status: number, body: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

  it("/api/health 回 ok: true 才算成功", async () => {
    let requested = "";
    const fetchFn = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response('{"ok":true}');
    }) as typeof fetch;
    expect(await checkServerHealth("http://s", fetchFn)).toEqual({ ok: true });
    expect(requested).toBe("http://s/api/health");
  });

  it("HTTP 錯誤、不是 Server 的回應、連線失敗都回傳原因", async () => {
    expect(await checkServerHealth("http://s", respond(404, {}))).toEqual({
      ok: false,
      message: "Server 回應 HTTP 404",
    });
    expect(await checkServerHealth("http://s", respond(200, { hello: 1 }))).toEqual({
      ok: false,
      message: "這個網址看起來不是 Server",
    });
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await checkServerHealth("http://s", failing)).toEqual({
      ok: false,
      message: "無法連線到 Server：ECONNREFUSED",
    });
  });
});
