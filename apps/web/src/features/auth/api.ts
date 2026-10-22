// 登入狀態：`GET /api/auth/me`，回應以 api-contract 的 MeResponse 驗證。

import { MeResponse } from "@orbis/api-contract";
import { queryOptions } from "@tanstack/react-query";

export const ME_PATH = "/api/auth/me";
export const GITHUB_LOGIN_PATH = "/api/auth/github/login";

/** Server 回 401：尚未登入或 session 已失效。 */
export class UnauthorizedError extends Error {
  constructor() {
    super("尚未登入");
    this.name = "UnauthorizedError";
  }
}

export async function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  const response = await fetch(ME_PATH, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) {
    throw new Error(`取得登入狀態失敗：HTTP ${response.status}`);
  }
  return MeResponse.parse(await response.json());
}

export const meQueryOptions = queryOptions({
  queryKey: ["auth", "me"],
  queryFn: ({ signal }) => fetchMe(signal),
  // 401 不重試，直接導向登入頁
  retry: (failureCount, error) => !(error instanceof UnauthorizedError) && failureCount < 2,
});
