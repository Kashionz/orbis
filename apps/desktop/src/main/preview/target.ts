// 內嵌瀏覽器要開哪個網址、可以前往哪些網址（ARCHITECTURE §13）。
// - 這台 Desktop 的 Local Runner 跑的 Run：直接開 `localhost:<port>`。
// - 其他 Run：開 Preview 網址。第一次開啟時經過 Web UI 的 authorize 換票，所以 authorize 也要放行。
// 網址一律由 main 程序自己向 Server 查詢後決定，Web UI 只給 Run ID，不能讓 Desktop 開任意網址。

import { z } from "zod";
import type { PreviewBounds, PreviewMode } from "../../bridge";

// TODO(contract): 契約 v2 合併後改用 api-contract 的 PreviewState 與 API_ROUTES（#29）。
export const PREVIEW_STATE_ROUTE = "/api/runs/:runId/preview";
// TODO(contract): 同上。
export const PREVIEW_AUTHORIZE_ROUTE = "/api/preview/:runId/authorize";

// TODO(contract): 同上。
export const PreviewState = z.object({
  status: z.enum(["not_configured", "starting", "ready", "stopped"]),
  /** 執行這個 Run 的 Runner。 */
  runnerId: z.string().nullable(),
  port: z.number().int().min(1).max(65_535).nullable(),
  /** Runner 本機的網址（`preview_ready` 的 url）。 */
  localUrl: z.string().nullable(),
  /** Preview 網址；Server 沒有設定 Preview 網域時是 null。 */
  shareUrl: z.string().nullable(),
});
export type PreviewState = z.infer<typeof PreviewState>;

export function previewStatePath(runId: string): string {
  return PREVIEW_STATE_ROUTE.replace(":runId", encodeURIComponent(runId));
}

export function previewAuthorizePath(runId: string): string {
  return PREVIEW_AUTHORIZE_ROUTE.replace(":runId", encodeURIComponent(runId));
}

export type PreviewTarget =
  | {
      mode: PreviewMode;
      runId: string;
      /** 第一次載入的網址。 */
      url: string;
      /** 留在內嵌瀏覽器中的 origin。 */
      origins: string[];
    }
  | { mode: "unavailable"; message: string };

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function resolvePreviewTarget(input: {
  runId: string;
  state: PreviewState;
  /** 這台 Desktop 的 Local Runner（sidecar 最後一次回報的 Runner ID）。 */
  localRunnerId: string | null;
}): PreviewTarget {
  const { runId, state, localRunnerId } = input;
  switch (state.status) {
    case "not_configured":
      return {
        mode: "unavailable",
        message: "這個 Repo 沒有設定 Preview（設定檔的 [preview].command）",
      };
    case "starting":
      return { mode: "unavailable", message: "Preview 啟動中…" };
    case "stopped":
      return { mode: "unavailable", message: "Preview 已停止" };
    case "ready":
      break;
  }

  if (localRunnerId !== null && state.runnerId === localRunnerId) {
    const local = parseLocalUrl(state.localUrl, state.port);
    if (local) {
      return {
        mode: "local",
        runId,
        url: local.href,
        origins: LOOPBACK_HOSTS.map((host) => `http://${host}:${local.port}`),
      };
    }
  }

  const share = parseShareUrl(state.shareUrl, runId);
  if (!share) {
    return {
      mode: "unavailable",
      message: "Server 沒有設定 Preview 網域，只能在執行這個 Run 的電腦上開啟 Preview",
    };
  }
  return { mode: "share", runId, url: share.href, origins: [share.origin] };
}

/** Runner 回報的本機網址：只接受 http、loopback、而且 port 和 Server 記錄的相同。 */
function parseLocalUrl(value: string | null, port: number | null): URL | null {
  if (!value || port === null) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.includes(url.hostname)) return null;
    if (Number(url.port) !== port) return null;
    return url;
  } catch {
    return null;
  }
}

/** Preview 網址：只接受 http(s)，而且 host 以這個 Run 的 ID 開頭（子網域式）。 */
function parseShareUrl(value: string | null, runId: string): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.startsWith(`${runId.toLowerCase()}.`)) return null;
    return url;
  } catch {
    return null;
  }
}

export type PreviewNavigationDecision = "allow" | "external" | "deny";

/**
 * 內嵌瀏覽器可以前往哪些網址：
 * - 這個 Preview 的 origin。
 * - Preview 網址換票時經過的 Web UI authorize（只限這個 Run）。
 * - 其他 http(s) 用外部瀏覽器開啟，其他 scheme 擋下。
 */
export function decidePreviewNavigation(
  target: string,
  preview: Extract<PreviewTarget, { origins: string[] }>,
  serverOrigin: string | null,
): PreviewNavigationDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "deny";
  }
  if (preview.origins.includes(url.origin)) return "allow";
  if (
    preview.mode === "share" &&
    serverOrigin !== null &&
    url.origin === serverOrigin &&
    url.pathname === previewAuthorizePath(preview.runId)
  ) {
    return "allow";
  }
  if (url.protocol === "https:" || url.protocol === "http:") return "external";
  return "deny";
}

/** 向 Server 查詢 Run 的 Preview 狀態；帶 Web UI 的 session cookie（由呼叫端的 fetch 處理）。 */
export async function fetchPreviewState(
  serverUrl: string,
  fetchFn: typeof fetch,
  runId: string,
): Promise<PreviewState | { error: string }> {
  let response: Response;
  try {
    response = await fetchFn(`${serverUrl}${previewStatePath(runId)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { error: `無法連線到 Server：${(error as Error).message}` };
  }
  if (response.status === 401) return { error: "尚未登入" };
  if (response.status === 403 || response.status === 404) return { error: "找不到這個 Run" };
  if (!response.ok) return { error: `查詢 Preview 失敗：HTTP ${response.status}` };
  const parsed = PreviewState.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : { error: "Server 回傳的 Preview 狀態格式不正確" };
}

/** 檢查 Web UI 傳來的位置；不合理的值回傳 null。 */
export function parsePreviewBounds(value: unknown): PreviewBounds | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const ok = (n: unknown, min: number) =>
    typeof n === "number" && Number.isFinite(n) && n >= min && n <= 100_000;
  if (!ok(v.x, -100_000) || !ok(v.y, -100_000) || !ok(v.width, 0) || !ok(v.height, 0)) {
    return null;
  }
  return {
    x: v.x as number,
    y: v.y as number,
    width: v.width as number,
    height: v.height as number,
  };
}

/** 檢查 Web UI 傳來的 Run ID。 */
export function parseRunId(value: unknown): string | null {
  return typeof value === "string" && /^[\w-]{1,100}$/.test(value) ? value : null;
}
