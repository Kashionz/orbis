// blob 的清理工作：刪除超過保存期限（預設 90 天）的 blob 內容與紀錄。
// run_events 本身不刪，Run 仍可完整重播；指向已刪除 blob 的參照在下載時回 410。

import { asc, eq, lte } from "drizzle-orm";
import type { Clock } from "../clock";
import type { Database } from "../db/client";
import { blobs } from "../db/schema";
import type { Logger } from "../logger";
import type { BlobStore } from "./store";

export const BLOB_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 500;

export class BlobCleanup {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private readonly db: Database,
    private readonly store: BlobStore,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  start(intervalMs = BLOB_CLEANUP_INTERVAL_MS): void {
    this.stop();
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 刪除所有到期的 blob，回傳刪除的數量。同時只會有一輪在跑。 */
  runOnce(): Promise<number> {
    this.running ??= this.sweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async sweep(): Promise<number> {
    let removed = 0;
    try {
      for (;;) {
        const expired = await this.db
          .select({ id: blobs.id, storageKey: blobs.storageKey })
          .from(blobs)
          .where(lte(blobs.expiresAt, this.clock.now()))
          .orderBy(asc(blobs.expiresAt))
          .limit(BATCH_SIZE);
        for (const blob of expired) {
          // 先刪內容再刪紀錄：中途失敗時紀錄還在，下一輪會再試。
          await this.store.delete(blob.storageKey);
          await this.db.delete(blobs).where(eq(blobs.id, blob.id));
          removed++;
        }
        if (expired.length < BATCH_SIZE) break;
      }
    } catch (error) {
      this.logger.error({ err: error, removed }, "清理到期的 blob 失敗");
    }
    if (removed > 0) this.logger.info({ removed }, "已清理到期的 blob");
    return removed;
  }
}
