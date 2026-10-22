// 登入狀態：`GET /api/auth/me`，回應以 api-contract 的 MeResponse 驗證。

import { MeResponse } from "@orbis/api-contract";
import { queryOptions } from "@tanstack/react-query";
import { ApiError, apiRequest, UnauthorizedError } from "../../api/client";

export { UnauthorizedError };

export const ME_PATH = "/api/auth/me";
export const GITHUB_LOGIN_PATH = "/api/auth/github/login";

export async function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  try {
    return await apiRequest(ME_PATH, MeResponse, { signal });
  } catch (error) {
    if (error instanceof ApiError) {
      throw new Error(`取得登入狀態失敗：HTTP ${error.status}`);
    }
    throw error;
  }
}

export const meQueryOptions = queryOptions({
  queryKey: ["auth", "me"],
  queryFn: ({ signal }) => fetchMe(signal),
  // 401 不重試，直接導向登入頁
  retry: (failureCount, error) => !(error instanceof UnauthorizedError) && failureCount < 2,
});
