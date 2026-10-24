// Server 的 `/api/health`：讀出版本（ARCHITECTURE §16「版本相容」）。載入後定期與視窗取得焦點時重新確認，
// Server 升級後開著的分頁也會看到提示。

import { API_ROUTES, HealthResponse } from "@orbis/api-contract";
import { queryOptions } from "@tanstack/react-query";
import { apiRequest } from "../../api/client";

/** 重新確認版本的間隔。 */
export const HEALTH_RECHECK_MS = 10 * 60_000;

export const healthQueryOptions = queryOptions({
  queryKey: ["health"],
  queryFn: ({ signal }) => apiRequest(API_ROUTES.health, HealthResponse, { signal }),
  staleTime: 60_000,
  refetchInterval: HEALTH_RECHECK_MS,
  refetchOnWindowFocus: true,
  retry: 1,
});
