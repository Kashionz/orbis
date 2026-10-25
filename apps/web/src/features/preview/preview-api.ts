// Run 的 Preview 狀態（ARCHITECTURE §13）：Server 依 Event 算出是否就緒，並附上 Preview 網址。

import { API_ROUTES, apiPath, PreviewScreenshotUploaded, PreviewState } from "@orbis/api-contract";
import { queryOptions } from "@tanstack/react-query";
import { ApiError, apiRequest, apiSend, UnauthorizedError } from "../../api/client";

export { PreviewState };

/** 還在啟動中時，每隔一段時間重新查詢。 */
const STARTING_REFETCH_MS = 2000;

export const previewStateQuery = (runId: string) =>
  queryOptions({
    queryKey: ["runs", runId, "preview"] as const,
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.runPreview, { runId }), PreviewState, { signal }),
    // 啟動中、或停止後可能被重新啟動：持續查詢到就緒
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "starting" || status === "stopped" ? STARTING_REFETCH_MS : false;
    },
  });

/** Preview 還不能開啟的原因；可以開啟時為 null。文字由 i18n 提供。 */
export type PreviewUnavailable = "not_configured" | "starting" | "stopped" | "no_domain";

export function unavailableReason(
  state: PreviewState,
  inDesktop: boolean,
): PreviewUnavailable | null {
  switch (state.status) {
    case "not_configured":
    case "starting":
    case "stopped":
      return state.status;
    case "ready":
      break;
  }
  // Desktop 可以直接開自己的 Local Runner 跑的 Run，是否能開由 Desktop 判斷
  if (inDesktop || state.shareUrl) return null;
  return "no_domain";
}

/** 重新啟動 Preview 的 dev server。 */
export function restartPreview(runId: string): Promise<void> {
  return apiSend(apiPath(API_ROUTES.runPreviewRestart, { runId }), { method: "POST" });
}

/** 上傳 Preview 留言的截圖（PNG），回傳 blob ID。 */
export async function uploadScreenshot(runId: string, screenshot: Blob): Promise<string> {
  const form = new FormData();
  form.append("file", new File([screenshot], "screenshot.png", { type: "image/png" }));
  const response = await fetch(apiPath(API_ROUTES.runPreviewScreenshots, { runId }), {
    method: "POST",
    credentials: "same-origin",
    body: form,
  });
  if (response.status === 401) throw new UnauthorizedError();
  const body = (await response.json().catch(() => null)) as {
    blobId?: string;
    error?: string;
    message?: string;
  } | null;
  const uploaded = PreviewScreenshotUploaded.safeParse(body);
  if (!response.ok || !uploaded.success) {
    throw new ApiError(
      response.status,
      body?.error ?? null,
      body?.message ?? `上傳截圖失敗：HTTP ${response.status}`,
    );
  }
  return uploaded.data.blobId;
}
