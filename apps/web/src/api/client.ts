// 呼叫 Server REST API 的共用函式：一律帶 session cookie、以 zod 驗證回應。

import { ApiError as ApiErrorBody, type READY_REQUIREMENTS } from "@orbis/api-contract";
import type { z } from "zod";
import { getMessages } from "../i18n";

type ReadyRequirement = (typeof READY_REQUIREMENTS)[number];

/** Server 回 401：尚未登入或 session 已失效。 */
export class UnauthorizedError extends Error {
  constructor() {
    super(getMessages().common.signedOut);
    this.name = "UnauthorizedError";
  }
}

/** 輸入驗證失敗時各欄位的問題（契約 ApiError 的 `issues`）。 */
export type ApiIssue = NonNullable<ApiErrorBody["issues"]>[number];

/** Server 回傳的錯誤（非 2xx）。`code` 是回應中的 `error` 欄位，沒有時為 null。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    /** 輸入驗證失敗時各欄位的問題。 */
    readonly issues: readonly ApiIssue[] = [],
    /** Task 進入 Ready 的條件不足時缺少的項目。 */
    readonly missing: readonly ReadyRequirement[] = [],
    /** `repo_not_connected` 時安裝 GitHub App 的網址。 */
    readonly installUrl: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiRequestInit {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    // 回應不是 JSON 時保留 HTTP 狀態碼作為訊息
    return new ApiError(response.status, null, `HTTP ${response.status}`);
  }
  const body = ApiErrorBody.safeParse(json);
  if (!body.success) return new ApiError(response.status, null, `HTTP ${response.status}`);
  const { error, message, issues = [], missing = [], installUrl = null } = body.data;
  return new ApiError(response.status, error, message || error, issues, missing, installUrl);
}

async function send(
  path: string,
  init: ApiRequestInit,
  accept = "application/json",
): Promise<Response> {
  const headers: Record<string, string> = { accept };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) throw await errorFromResponse(response);
  return response;
}

/** 送出請求並以 `schema` 驗證回應內容。 */
export async function apiRequest<S extends z.ZodType>(
  path: string,
  schema: S,
  init: ApiRequestInit = {},
): Promise<z.infer<S>> {
  const response = await send(path, init);
  return schema.parse(await response.json());
}

/** 取得純文字內容（blob）。 */
export async function apiText(path: string, init: ApiRequestInit = {}): Promise<string> {
  const response = await send(path, init, "*/*");
  return response.text();
}

/** 送出不需要回應內容的請求（例如 204）。 */
export async function apiSend(path: string, init: ApiRequestInit = {}): Promise<void> {
  await send(path, init);
}

/**
 * 給人看的錯誤訊息。Ready 條件不足時依 `missing` 列出缺少的項目；
 * 輸入驗證失敗時每個欄位的問題各一行。
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const t = getMessages();
    if (error.missing.length > 0) {
      return t.common.notReadyMissing(
        error.missing.map((m) => t.labels.readyRequirement[m]).join(t.common.listSeparator),
      );
    }
    let text = error.status === 403 ? t.common.forbidden(error.message) : error.message;
    for (const issue of error.issues) {
      const field = issue.path.join(".");
      text += field
        ? `
${field}：${issue.message}`
        : `
${issue.message}`;
    }
    return text;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
