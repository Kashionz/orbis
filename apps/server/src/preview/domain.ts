// Preview 網址（ARCHITECTURE §13）：`<scheme>://<run-id>.<Preview 網域>/`。
// Preview 網域由 Server 設定的 Preview 網域環境變數（CONFIG_ENV.previewDomain）設定（例如 `preview.example.com`，開發時 `preview.localhost:4500`），
// scheme 和 Web UI（publicUrl）相同。這個檔案只處理字串，不依賴 Hono 與 DB。

import { NAMES } from "@orbis/api-contract";
import { z } from "zod";

export interface PreviewDomain {
  scheme: "http" | "https";
  /** 小寫的 host，可以帶 port；不含預設 port。 */
  host: string;
}

/** Preview 網址上保留給 Server 的路徑前綴（換票的 callback 等），不轉送給 dev server。 */
export const PREVIEW_RESERVED_PREFIX = `/__${NAMES.productSlug}/`;
/** 換票的 callback。 */
export const PREVIEW_CALLBACK_PATH = `${PREVIEW_RESERVED_PREFIX}callback`;
/** Preview 網址上的 session cookie（host-only，只屬於這個 Run 的 Preview 網址）。 */
export const PREVIEW_COOKIE = `${NAMES.productSlug}_preview`;

const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/** 檢查設定值；格式錯誤時回傳錯誤訊息（給 config 的驗證使用）。 */
export function previewDomainProblem(value: string): string | null {
  const host = value.trim().toLowerCase();
  if (host.includes("://") || host.includes("/"))
    return "只填網域（例如 preview.example.com），不含 scheme 與路徑";
  if (!HOST_PATTERN.test(host)) return "不是合法的網域";
  return null;
}

/** 由設定值與 Web UI 的網址組出 Preview 網域；沒有設定時是 null。 */
export function parsePreviewDomain(
  value: string | null | undefined,
  publicUrl: string,
): PreviewDomain | null {
  if (!value || previewDomainProblem(value)) return null;
  const scheme = publicUrl.startsWith("https:") ? "https" : "http";
  return { scheme, host: withoutDefaultPort(value.trim().toLowerCase(), scheme) };
}

function withoutDefaultPort(host: string, scheme: "http" | "https"): string {
  const defaultPort = scheme === "https" ? ":443" : ":80";
  return host.endsWith(defaultPort) ? host.slice(0, -defaultPort.length) : host;
}

/** Run 的 Preview 網址（結尾有 `/`）。 */
export function previewShareUrl(runId: string, domain: PreviewDomain): string {
  return `${domain.scheme}://${runId.toLowerCase()}.${domain.host}/`;
}

/** 請求的 Host 是某個 Run 的 Preview 網址時回傳 Run ID，否則回傳 null。 */
export function runIdFromHost(
  host: string | undefined,
  domain: PreviewDomain | null,
): string | null {
  if (!host || !domain) return null;
  const normalized = withoutDefaultPort(host.trim().toLowerCase(), domain.scheme);
  const suffix = `.${domain.host}`;
  if (!normalized.endsWith(suffix)) return null;
  const label = normalized.slice(0, -suffix.length);
  return z.uuid().safeParse(label).success ? label : null;
}

/** 解析 `return` 用的假 origin；解析後 origin 不變才表示是同一個 origin 內的路徑。 */
const RETURN_BASE = "http://return.invalid";

/**
 * callback 與 authorize 的 `return`：只接受同一個 origin 內的路徑。
 * 先拒絕控制字元與反斜線（瀏覽器會去掉 tab、換行，或把 `\` 當成 `/`，例如 `/<tab>/evil.test`
 * 會變成 `//evil.test`），再以 URL 解析確認沒有跳到其他 origin。
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || value.length > 2000) return "/";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要擋下控制字元
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, RETURN_BASE);
    if (url.origin !== RETURN_BASE) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
