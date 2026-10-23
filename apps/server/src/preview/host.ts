// Preview 網址（`<run-id>.<Preview 網域>`）上的請求（ARCHITECTURE §13）：
// - `/__<product slug>/callback`：以 ticket 換成 preview cookie，再導回原本的路徑。
// - 其他請求先檢查 preview cookie：沒有或失效時，頁面導覽轉到 Web UI 的 authorize 換票，其他請求回 401。
// - 通過檢查的請求交給 relay 經由 Runner 通道轉送；relay 未提供時回 503。

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { parse as parseCookie } from "hono/utils/cookie";
import type { PreviewAuth } from "./auth";
import {
  PREVIEW_CALLBACK_PATH,
  PREVIEW_COOKIE,
  PREVIEW_RESERVED_PREFIX,
  type PreviewDomain,
  previewShareUrl,
  runIdFromHost,
  safeReturnPath,
} from "./domain";
import { previewAuthorizeUrl } from "./routes";

/** 經由 Runner 通道轉送；`request` 已移除 preview cookie。 */
export interface PreviewRelay {
  fetch(runId: string, request: Request): Promise<Response>;
  upgrade(runId: string, request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export interface PreviewHostDeps {
  domain: PreviewDomain | null;
  publicUrl: string;
  auth: PreviewAuth;
  /** 未提供時，通過登入檢查的請求回 503（測試用）。 */
  relay?: PreviewRelay;
}

export interface PreviewHost {
  /** 這個 Host 是不是某個 Run 的 Preview 網址；是的話回傳 Run ID。 */
  runIdFor(host: string | undefined): string | null;
  fetch(runId: string, request: Request): Promise<Response>;
  upgrade(runId: string, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
}

function isNavigation(request: Request): boolean {
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
}

function html(status: number, title: string, message: string): Response {
  const escapeHtml = (s: string) =>
    s.replace(
      /[&<>"]/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch,
    );
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
      `<body style="font:16px sans-serif;padding:2rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

/**
 * 是不是從其他 origin 發出、不能接受的請求（例如其他 Run 的 Preview 頁面；它們和這個 Preview 網址是
 * same-site，會帶著 SameSite=Lax 的 preview cookie）。GET／HEAD 的頁面導覽（使用者點連結、Web UI 的
 * iframe）可以；其他 method 的導覽（例如跨站的表單 POST）必須來自這個 Preview 網址自己。
 */
export function isCrossOrigin(
  method: string,
  headers: { get(name: string): string | null },
  previewOrigin: string,
): boolean {
  const origin = headers.get("origin");
  if (headers.get("sec-fetch-mode") === "navigate") {
    if (method === "GET" || method === "HEAD") return false;
    return origin !== previewOrigin;
  }
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  return origin !== null && origin !== previewOrigin;
}

/** 移除 Orbis 自己的 preview cookie，其餘 cookie 原樣留給 dev server。 */
export function withoutPreviewCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const kept = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${PREVIEW_COOKIE}=`));
  return kept.length > 0 ? kept.join("; ") : null;
}

function previewOrigin(runId: string, domain: PreviewDomain): string {
  return new URL(previewShareUrl(runId, domain)).origin;
}

export function createPreviewHost(deps: PreviewHostDeps): PreviewHost {
  const secure = deps.domain?.scheme === "https";

  async function authorized(runId: string, cookieHeader: string | undefined): Promise<boolean> {
    const cookie = parseCookie(cookieHeader ?? "", PREVIEW_COOKIE)[PREVIEW_COOKIE];
    return deps.auth.check(cookie, runId);
  }

  return {
    runIdFor: (host) => runIdFromHost(host, deps.domain),

    async fetch(runId, request) {
      const url = new URL(request.url);
      if (url.pathname === PREVIEW_CALLBACK_PATH) {
        const value = deps.auth.redeemTicket(url.searchParams.get("ticket") ?? "", runId);
        if (!value)
          return html(403, "無法開啟 Preview", "連結已失效，請從 Run 頁面重新開啟 Preview。");
        const cookie = [
          `${PREVIEW_COOKIE}=${value}`,
          "Path=/",
          "HttpOnly",
          "SameSite=Lax",
          ...(secure ? ["Secure"] : []),
        ].join("; ");
        return new Response(null, {
          status: 302,
          headers: {
            location: safeReturnPath(url.searchParams.get("return")),
            "set-cookie": cookie,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      }
      if (url.pathname.startsWith(PREVIEW_RESERVED_PREFIX)) {
        return html(404, "找不到頁面", "這個路徑保留給 Server 使用。");
      }
      if (
        deps.domain &&
        isCrossOrigin(request.method, request.headers, previewOrigin(runId, deps.domain))
      ) {
        return new Response("不接受其他網站發出的請求", { status: 403 });
      }
      if (!(await authorized(runId, request.headers.get("cookie") ?? undefined))) {
        if (isNavigation(request)) {
          const returnPath = `${url.pathname}${url.search}`;
          return new Response(null, {
            status: 302,
            headers: {
              location: previewAuthorizeUrl(deps.publicUrl, runId, returnPath),
              "cache-control": "no-store",
            },
          });
        }
        return new Response("尚未登入", { status: 401 });
      }
      if (!deps.relay) return html(503, "Preview 尚未提供", "Server 還不能轉送 Preview 的流量。");
      const headers = new Headers(request.headers);
      const cookie = withoutPreviewCookie(headers.get("cookie"));
      if (cookie) headers.set("cookie", cookie);
      else headers.delete("cookie");
      const response = await deps.relay.fetch(runId, new Request(request, { headers }));
      // 只有 Web UI（Preview 分頁的 iframe）與 Preview 自己可以嵌入，避免其他網站 clickjacking
      response.headers.append(
        "content-security-policy",
        `frame-ancestors 'self' ${new URL(deps.publicUrl).origin}`,
      );
      return response;
    },

    async upgrade(runId, request, socket, head) {
      const headers = {
        get: (name: string) => {
          const value = request.headers[name];
          return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
        },
      };
      // WebSocket 不受 CORS 保護：瀏覽器一定會帶 Origin，必須是這個 Preview 網址自己
      if (deps.domain && isCrossOrigin("GET", headers, previewOrigin(runId, deps.domain))) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (!(await authorized(runId, request.headers.cookie))) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (!deps.relay) {
        socket.end(
          "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      const cookie = withoutPreviewCookie(request.headers.cookie ?? null);
      if (cookie) request.headers.cookie = cookie;
      else delete request.headers.cookie;
      deps.relay.upgrade(runId, request, socket, head);
    },
  };
}
