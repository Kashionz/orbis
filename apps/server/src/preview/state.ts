// Run 的 Preview 狀態（`GET /api/runs/:runId/preview`）：由 Run 的狀態與最後一個 Preview 相關的 Event 算出。

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { RunRow } from "../authz/scope";
import type { Database } from "../db/client";
import { runEvents } from "../db/schema";
import { TERMINAL_RUN_STATUSES } from "../domain/run-status";
import { type PreviewDomain, previewShareUrl } from "./domain";

// TODO(contract): 契約 v2 合併後改用 api-contract 的 PreviewState 與 API_ROUTES（#29）。
export const PREVIEW_STATE_ROUTE = "/api/runs/:runId/preview";
// TODO(contract): 同上。
export const PREVIEW_AUTHORIZE_ROUTE = "/api/preview/:runId/authorize";

// TODO(contract): 同上；欄位和 apps/desktop/src/main/preview/target.ts 的暫時型別一致。
export const PreviewState = z.object({
  status: z.enum(["not_configured", "starting", "ready", "stopped"]),
  runnerId: z.string().nullable(),
  port: z.number().int().nullable(),
  localUrl: z.string().nullable(),
  shareUrl: z.string().nullable(),
});
export type PreviewState = z.infer<typeof PreviewState>;

/**
 * Runner 暫時以非 fatal 的 error Event 回報 Preview 停止，訊息以這段文字開頭
 * （crates/runner/src/run.rs 的 start_preview）。
 */
// TODO(contract): 契約 v2 加入 `preview_stopped` Event 後改用它（#29）。
const STOPPED_MESSAGE_PREFIX = "Preview 已停止";

export async function loadPreviewState(
  db: Database,
  run: Pick<RunRow, "id" | "status" | "runnerId">,
  domain: PreviewDomain | null,
): Promise<PreviewState> {
  const shareUrl = domain ? previewShareUrl(run.id, domain) : null;
  const [last] = await db
    .select({ kind: runEvents.kind, payload: runEvents.payload })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, run.id),
        or(
          inArray(runEvents.kind, ["preview_ready"]),
          and(
            eq(runEvents.kind, "error"),
            sql`${runEvents.payload}->>'message' LIKE ${`${STOPPED_MESSAGE_PREFIX}%`}`,
          ),
        ),
      ),
    )
    .orderBy(desc(runEvents.seq))
    .limit(1);
  const ready =
    last?.kind === "preview_ready" ? (last.payload as { port: number; url: string }) : null;
  const terminal = TERMINAL_RUN_STATUSES.includes(run.status);
  // TODO(contract): 沒有設定 `[preview]` 的 Repo 目前無法和「啟動中」區分，契約 v2 補上後改成 not_configured。
  const status = terminal || (last && !ready) ? "stopped" : ready ? "ready" : "starting";
  return {
    status,
    runnerId: run.runnerId,
    port: ready?.port ?? null,
    localUrl: ready?.url ?? null,
    shareUrl,
  };
}
