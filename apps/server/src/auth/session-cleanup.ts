// session 的結束：登出與清除過期 session。刪除 session 之前，先撤銷它配對出的 Local Runner
// 並立刻斷線（ARCHITECTURE §16），避免登出後 Runner 還能以原本的身分接工作。

import { asc, eq, inArray, lte } from "drizzle-orm";
import { sha256Hex } from "../crypto";
import { sessions } from "../db/schema";
import type { Logger } from "../logger";
import { type RevokeDeps, revokeSessionRunners } from "../runner/revoke";
import type { TerminalHub } from "../terminal/hub";

export const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 500;

/** 登出：撤銷這個 session 配對的 Local Runner，再刪除 session。token 不存在時什麼都不做。 */
export async function endSession(
  deps: RevokeDeps & { terminals?: Pick<TerminalHub, "closeSession"> },
  sessionToken: string,
): Promise<void> {
  const [session] = await deps.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.tokenHash, sha256Hex(sessionToken)));
  if (!session) return;
  // 這個 session 開的終端機一起關閉（ADR-0014）。
  await deps.terminals?.closeSession(session.id);
  await revokeSessionRunners(deps, [session.id]);
  await deps.db.delete(sessions).where(eq(sessions.id, session.id));
}

/** 定期清除過期的 session。 */
export class SessionCleanup {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private readonly deps: RevokeDeps,
    private readonly logger: Logger,
  ) {}

  start(intervalMs = SESSION_CLEANUP_INTERVAL_MS): void {
    this.stop();
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 刪除所有過期的 session，回傳刪除的數量。同時只會有一輪在跑。 */
  runOnce(): Promise<number> {
    this.running ??= this.sweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async sweep(): Promise<number> {
    const { db, clock } = this.deps;
    let removed = 0;
    let revoked = 0;
    try {
      for (;;) {
        const expired = await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(lte(sessions.expiresAt, clock.now()))
          .orderBy(asc(sessions.expiresAt))
          .limit(BATCH_SIZE);
        const ids = expired.map((s) => s.id);
        // 先撤銷 Runner 再刪 session：中途失敗時 session 還在，下一輪會再試。
        revoked += (await revokeSessionRunners(this.deps, ids)).length;
        if (ids.length > 0) await db.delete(sessions).where(inArray(sessions.id, ids));
        removed += ids.length;
        if (expired.length < BATCH_SIZE) break;
      }
    } catch (error) {
      this.logger.error({ err: error, removed }, "清除過期的 session 失敗");
    }
    if (removed > 0) this.logger.info({ removed, revokedRunners: revoked }, "已清除過期的 session");
    return removed;
  }
}
