// 主視窗可以前往哪些網址。只有 Server 的 Web UI 與 GitHub 的 OAuth 登入頁留在 App 內，
// 其他 http(s) 連結用外部瀏覽器開啟，其他 scheme 一律擋下。

export type NavigationDecision = "allow" | "external" | "deny";

/** GitHub OAuth 登入過程中會經過的頁面（授權、登入、兩步驟驗證）。 */
const GITHUB_OAUTH_PATHS = [/^\/login(\/|$)/, /^\/session(\/|$)/, /^\/sessions\//];

export function decideNavigation(target: string, serverOrigin: string): NavigationDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "deny";
  }
  if (url.origin === serverOrigin) return "allow";
  if (
    url.protocol === "https:" &&
    url.host === "github.com" &&
    GITHUB_OAUTH_PATHS.some((p) => p.test(url.pathname))
  ) {
    return "allow";
  }
  if (url.protocol === "https:" || url.protocol === "http:") return "external";
  return "deny";
}

/** IPC 只接受來自 Server origin 主 frame 的呼叫（子 frame 與其他網站不行）。 */
export function isTrustedSender(
  frameUrl: string | undefined,
  isMainFrame: boolean,
  serverOrigin: string | null,
): boolean {
  if (!isMainFrame || !frameUrl || !serverOrigin) return false;
  try {
    return new URL(frameUrl).origin === serverOrigin;
  } catch {
    return false;
  }
}
