// API 的錯誤格式：一律回 `{ error, message }`，驗證失敗另外附上 `issues`。

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { Logger } from "../logger";

export type ApiErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "no_team"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_transition"
  | "gone"
  | "payload_too_large";

export class ApiError extends Error {
  override name = "ApiError";

  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `找不到${what}`);
export const forbidden = (reason: string) => new ApiError(403, "forbidden", reason);
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new ApiError(409, "conflict", message, details);

/** zod 驗證失敗轉成 400。 */
export function invalidInput(error: z.ZodError): ApiError {
  return new ApiError(400, "invalid_input", "輸入格式不正確", {
    issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
  });
}

/** Hono 的 onError：ApiError 照原樣回應，其他錯誤記 log 後回 500。 */
export function handleError(logger: Logger) {
  return (error: Error, c: Context) => {
    if (error instanceof ApiError) {
      return c.json({ error: error.code, message: error.message, ...error.details }, error.status);
    }
    logger.error({ err: error, path: c.req.path }, "處理 HTTP 請求時發生錯誤");
    return c.json({ error: "internal_error", message: "Server 發生錯誤" }, 500);
  };
}

/** 讀取並驗證 JSON body。 */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_input", "request body 必須是 JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalidInput(parsed.error);
  return parsed.data;
}

/** 驗證 query string。 */
export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw invalidInput(parsed.error);
  return parsed.data;
}

/** 路徑參數中的 ID：Server 的 ID 都是 UUID，格式不符直接當作找不到。 */
export function readId(c: Context, name: string, what: string): string {
  const value = c.req.param(name);
  if (!value || !z.uuid().safeParse(value).success) throw notFound(what);
  return value;
}
