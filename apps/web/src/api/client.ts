// 呼叫 Server REST API 的共用函式：一律帶 session cookie、以 zod 驗證回應。

import type { z } from "zod";

/** Server 回 401：尚未登入或 session 已失效。 */
export class UnauthorizedError extends Error {
  constructor() {
    super("尚未登入");
    this.name = "UnauthorizedError";
  }
}

/** Server 回傳的錯誤（非 2xx）。`code` 是回應中的 `error` 欄位，沒有時為 null。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
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
  let code: string | null = null;
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string") code = body.error;
    if (typeof body.message === "string") message = body.message;
    else if (code) message = code;
  } catch {
    // 回應不是 JSON 時保留 HTTP 狀態碼作為訊息
  }
  return new ApiError(response.status, code, message);
}

async function send(path: string, init: ApiRequestInit): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
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

/** 送出不需要回應內容的請求（例如 204）。 */
export async function apiSend(path: string, init: ApiRequestInit = {}): Promise<void> {
  await send(path, init);
}

/** 給人看的錯誤訊息。 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return `沒有權限：${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
