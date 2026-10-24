// Event 的保存位置（ARCHITECTURE §14）。`(run_id, seq)` 是主鍵，重送的 Event 直接略過。
// 另外記住每個 Run「連續保存到哪個 seq」，供 event_ack、hello_ack 的 resume 與改派時的 last_event_seq 使用。

import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { runEvents } from "../db/schema";
import type { Executor } from "../db/tx";

export interface StoredEvent {
  runId: string;
  seq: number;
  ts: Date;
  kind: string;
  /** 協定的 EventKind（含 `kind`），原樣保存。 */
  payload: Record<string, unknown>;
}

export class EventStore {
  /** 每個 Run 已連續保存的最大 seq（快取）。 */
  private readonly contiguous = new Map<string, number>();
  private readonly listeners = new Set<(runId: string) => void>();

  constructor(private readonly db: Database) {}

  /** 寫入一筆 Event；已存在（重送）時回傳 false。 */
  async insert(tx: Executor, event: StoredEvent): Promise<boolean> {
    const inserted = await tx
      .insert(runEvents)
      .values(event)
      .onConflictDoNothing()
      .returning({ seq: runEvents.seq });
    return inserted.length > 0;
  }

  /** 已連續保存的最大 seq；還沒有任何 Event 時為 0。 */
  async lastContiguousSeq(runId: string): Promise<number> {
    let current = this.contiguous.get(runId);
    if (current === undefined) {
      const result = await this.db.execute<{ last: string | number | null }>(sql`
        select max(seq) as last from (
          select seq, row_number() over (order by seq) as n
          from ${runEvents} where ${runEvents.runId} = ${runId}
        ) t where seq = n`);
      current = Number(result.rows[0]?.last ?? 0);
    }
    // 從快取的位置往後補上新到的 Event。
    for (;;) {
      const next = await this.db
        .select({ seq: runEvents.seq })
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, current)))
        .orderBy(asc(runEvents.seq))
        .limit(500);
      let advanced = false;
      for (const row of next) {
        if (row.seq !== current + 1) break;
        current = row.seq;
        advanced = true;
      }
      if (!advanced || next.length < 500) break;
    }
    this.contiguous.set(runId, current);
    return current;
  }

  /** 讀取 afterSeq 之後的 Event（依 seq 排序）。 */
  async list(runId: string, afterSeq: number, limit: number) {
    return this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
      .orderBy(asc(runEvents.seq))
      .limit(limit);
  }

  /** 最新一筆某種 kind 的 Event。 */
  async latestOfKind(runId: string, kind: string, atOrBeforeSeq?: number) {
    const [row] = await this.db
      .select()
      .from(runEvents)
      .where(
        and(
          eq(runEvents.runId, runId),
          eq(runEvents.kind, kind),
          atOrBeforeSeq === undefined ? undefined : lte(runEvents.seq, atOrBeforeSeq),
        ),
      )
      .orderBy(sql`${runEvents.seq} desc`)
      .limit(1);
    return row ?? null;
  }

  /** 有新 Event 寫入時通知（Web 推送用）。 */
  onAppended(listener: (runId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyAppended(runId: string): void {
    for (const listener of this.listeners) listener(runId);
  }
}
