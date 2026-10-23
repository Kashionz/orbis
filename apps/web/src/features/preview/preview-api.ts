// Run 的 Preview 狀態（ARCHITECTURE §13）：Server 依 Event 算出是否就緒，並附上 Preview 網址。

import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest } from "../../api/client";

// TODO(contract): 契約 v2 合併後改用 api-contract 的 PreviewState 與 API_ROUTES（#29）。
const PREVIEW_STATE_ROUTE = "/api/runs/:runId/preview";

// TODO(contract): 同上；欄位和 apps/server/src/preview/state.ts 的暫時型別一致。
export const PreviewState = z.object({
  status: z.enum(["not_configured", "starting", "ready", "stopped"]),
  runnerId: z.string().nullable(),
  port: z.number().int().nullable(),
  localUrl: z.string().nullable(),
  shareUrl: z.string().nullable(),
});
export type PreviewState = z.infer<typeof PreviewState>;

/** 還在啟動中時，每隔一段時間重新查詢。 */
const STARTING_REFETCH_MS = 2000;

export const previewStateQuery = (runId: string) =>
  queryOptions({
    queryKey: ["runs", runId, "preview"] as const,
    queryFn: ({ signal }) =>
      apiRequest(PREVIEW_STATE_ROUTE.replace(":runId", encodeURIComponent(runId)), PreviewState, {
        signal,
      }),
    refetchInterval: (query) =>
      query.state.data?.status === "starting" ? STARTING_REFETCH_MS : false,
  });

/** Preview 還不能開啟時給人看的說明；可以開啟時回傳 null。 */
export function unavailableMessage(state: PreviewState, inDesktop: boolean): string | null {
  switch (state.status) {
    case "not_configured":
      return "這個 Repo 沒有設定 Preview（設定檔的 [preview].command）";
    case "starting":
      return "Preview 啟動中…";
    case "stopped":
      return "Preview 已停止";
    case "ready":
      break;
  }
  // Desktop 可以直接開自己的 Local Runner 跑的 Run，是否能開由 Desktop 判斷
  if (inDesktop || state.shareUrl) return null;
  return "Server 沒有設定 Preview 網域，只能在執行這個 Run 的電腦上用 Desktop 開啟 Preview";
}
