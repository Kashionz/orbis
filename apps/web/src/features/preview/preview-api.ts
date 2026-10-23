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

/** Preview 還不能開啟時給人看的說明；可以開啟時回傳 null。 */
export function unavailableMessage(state: PreviewState, inDesktop: boolean): string | null {
  switch (state.status) {
    case "not_configured":
      return "這個 Repo 沒有設定 Preview（設定檔的 [preview].command）";
    case "starting":
      return "Preview 啟動中…";
    case "stopped":
      return stoppedMessage(state);
    case "ready":
      break;
  }
  // Desktop 可以直接開自己的 Local Runner 跑的 Run，是否能開由 Desktop 判斷
  if (inDesktop || state.shareUrl) return null;
  return "Server 沒有設定 Preview 網域，只能在執行這個 Run 的電腦上用 Desktop 開啟 Preview";
}

type StopReason = NonNullable<PreviewState["stopped"]>["reason"];

const STOP_REASON_LABELS: Record<StopReason, string> = {
  exited: "dev server 結束了",
  ready_timeout: "等待就緒逾時",
  spawn_failed: "無法啟動 dev server",
};

/** Preview 停止的說明（Run 結束時沒有停止原因）。 */
export function stoppedMessage(state: PreviewState): string {
  const stopped = state.stopped;
  if (!stopped) return "Preview 已停止";
  const exit = stopped.exitCode === null ? "" : `，結束碼 ${stopped.exitCode}`;
  return `Preview 已停止（${STOP_REASON_LABELS[stopped.reason]}${exit}）`;
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
