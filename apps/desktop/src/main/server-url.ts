// Server URL：使用者在第一次啟動時輸入的 Web UI origin。

import { API_ROUTES, HealthResponse } from "@orbis/api-contract";

export type ServerUrlResult = { ok: true; url: string } | { ok: false; message: string };

/**
 * 正規化並驗證 Server URL。只接受 http／https 的 origin（不含路徑、帳密、query），
 * 沒有寫 scheme 時補上 https。回傳的網址沒有結尾的斜線。
 */
export function normalizeServerUrl(input: string): ServerUrlResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, message: "請輸入 Server URL" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: "不是合法的網址" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "只支援 http:// 或 https://" };
  }
  if (url.username || url.password) {
    return { ok: false, message: "網址不可以包含帳號密碼" };
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    return { ok: false, message: "請只輸入 origin，例如 https://example.com，不要包含路徑" };
  }
  return { ok: true, url: url.origin };
}

export type HealthCheckResult =
  | {
      ok: true;
      /**
       * Server 回報的 API origin（Runner 連 `<apiOrigin>/runner`）。回應沒有這個欄位、或不是合法的
       * http／https origin 時為 null，由呼叫端退回使用 Web UI 的 origin。
       */
      apiOrigin: string | null;
    }
  | { ok: false; message: string };

/**
 * 確認網址上確實是 Server：`GET /api/health` 回 `{ ok: true }`，同時讀出 `apiOrigin`（HealthResponse）。
 * 還沒回報 apiOrigin 的舊版 Server 也接受，由呼叫端退回使用 Web UI 的 origin。
 */
export async function checkServerHealth(
  serverUrl: string,
  fetchFn: typeof fetch,
  timeoutMs = 5_000,
): Promise<HealthCheckResult> {
  try {
    const response = await fetchFn(`${serverUrl}${API_ROUTES.health}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, message: `Server 回應 HTTP ${response.status}` };
    const body: unknown = await response.json().catch(() => null);
    const health = HealthResponse.safeParse(body);
    if (health.success) return { ok: true, apiOrigin: parseApiOrigin(health.data.apiOrigin) };
    if ((body as { ok?: unknown } | null)?.ok !== true) {
      return { ok: false, message: "這個網址看起來不是 Server" };
    }
    return { ok: true, apiOrigin: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `無法連線到 Server：${message}` };
  }
}

/** `apiOrigin` 一定要明確寫出 http:// 或 https://，不替它補 scheme；帶有路徑時視為沒有。 */
function parseApiOrigin(value: string): string | null {
  if (!/^https?:\/\//i.test(value.trim())) return null;
  const normalized = normalizeServerUrl(value);
  return normalized.ok ? normalized.url : null;
}

/**
 * Runner 要連線的 Server（ARCHITECTURE §16）：環境變數覆寫優先，其次是 `/api/health` 回報的
 * `apiOrigin`；取不到時（舊版 Server、暫時連不上）退回 Web UI 的 origin。
 */
export async function resolveRunnerServerUrl(
  webOrigin: string,
  fetchFn: typeof fetch,
  override?: string,
): Promise<string> {
  if (override) return override;
  const health = await checkServerHealth(webOrigin, fetchFn);
  return (health.ok && health.apiOrigin) || webOrigin;
}
