// Server URL：使用者在第一次啟動時輸入的 Web UI origin。

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

export type HealthCheckResult = { ok: true } | { ok: false; message: string };

/** 確認網址上確實是 Server：`GET /api/health` 回 `{ ok: true }`。 */
export async function checkServerHealth(
  serverUrl: string,
  fetchFn: typeof fetch,
  timeoutMs = 5_000,
): Promise<HealthCheckResult> {
  try {
    const response = await fetchFn(`${serverUrl}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, message: `Server 回應 HTTP ${response.status}` };
    const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    if (body?.ok !== true) return { ok: false, message: "這個網址看起來不是 Server" };
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `無法連線到 Server：${message}` };
  }
}
