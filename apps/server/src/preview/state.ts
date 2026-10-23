// Run 的 Preview 狀態（`GET API_ROUTES.runPreview`）：由 Run 的狀態與 Preview 相關的 Event 算出。
// - `worktree_ready` 的 `preview_port`：沒有值表示 Repo 沒有設定 `[preview]`。
// - 最後一個 `preview_ready`／`preview_stopped` 決定就緒或停止；Run 結束時 Preview 一併停止。

import type { PreviewState } from "@orbis/api-contract";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { RunRow } from "../authz/scope";
import type { Database } from "../db/client";
import { runEvents } from "../db/schema";
import { TERMINAL_RUN_STATUSES } from "../domain/run-status";
import { type PreviewDomain, previewShareUrl } from "./domain";

interface StoredEvent {
  kind: string;
  payload: Record<string, unknown>;
}

async function lastEvent(
  db: Database,
  runId: string,
  kinds: string[],
): Promise<StoredEvent | null> {
  const [row] = await db
    .select({ kind: runEvents.kind, payload: runEvents.payload })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), inArray(runEvents.kind, kinds)))
    .orderBy(desc(runEvents.seq))
    .limit(1);
  return row ? { kind: row.kind, payload: row.payload as Record<string, unknown> } : null;
}

export async function loadPreviewState(
  db: Database,
  run: Pick<RunRow, "id" | "status" | "runnerId">,
  domain: PreviewDomain | null,
): Promise<PreviewState> {
  const [worktree, latest, stoppedEvent] = await Promise.all([
    lastEvent(db, run.id, ["worktree_ready"]),
    lastEvent(db, run.id, ["preview_ready", "preview_stopped"]),
    lastEvent(db, run.id, ["preview_stopped"]),
  ]);
  const stopped = stoppedEvent
    ? {
        reason: stoppedEvent.payload.reason as NonNullable<PreviewState["stopped"]>["reason"],
        exitCode: (stoppedEvent.payload.exit_code as number | null | undefined) ?? null,
        output: String(stoppedEvent.payload.output ?? ""),
      }
    : null;
  const configuredPort = worktree
    ? ((worktree.payload.preview_port as number | null | undefined) ?? null)
    : undefined;
  const base = { runnerId: run.runnerId, stopped };

  if (configuredPort === null) {
    return { ...base, status: "not_configured", port: null, localUrl: null, shareUrl: null };
  }
  const port = configuredPort ?? null;
  if (TERMINAL_RUN_STATUSES.includes(run.status) || latest?.kind === "preview_stopped") {
    return { ...base, status: "stopped", port, localUrl: null, shareUrl: null };
  }
  if (latest?.kind === "preview_ready") {
    return {
      ...base,
      status: "ready",
      port: (latest.payload.port as number | undefined) ?? port,
      localUrl: String(latest.payload.url),
      shareUrl: domain ? previewShareUrl(run.id, domain) : null,
    };
  }
  // 還沒建立 Worktree，或 dev server 還沒就緒
  return { ...base, status: "starting", port, localUrl: null, shareUrl: null };
}
