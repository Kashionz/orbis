// Preview 網址的登入保護（ARCHITECTURE §13「換票」）：
// 1. Web UI 的 authorize 確認 session 與 Run 的查看權限後，發一次性、60 秒有效的 ticket。
// 2. Preview 網址的 callback 以 ticket 換成 preview session（cookie）。
// 3. 之後每個請求檢查 preview session：綁定的 Orbis session 仍然有效、仍然能查看這個 Run。
//    檢查結果快取 5 秒，所以登出或 session 過期後最多 5 秒內失效。
// ticket 與 preview session 只存在記憶體中（Phase 1 只有單一 Server）；Server 重新啟動後，
// 頁面導覽會自動重新換票。

import { randomBytes } from "node:crypto";
import type { Clock } from "../clock";

export const TICKET_TTL_MS = 60_000;
/** preview session 最長的有效時間（也受綁定的 Orbis session 限制）。 */
export const PREVIEW_SESSION_TTL_MS = 12 * 60 * 60_000;
/** 權限檢查結果的快取時間。 */
export const ACCESS_CACHE_MS = 5_000;

/** 某個 Orbis session 是否仍然有效、而且能查看這個 Run。 */
export type CanViewRun = (sessionId: string, runId: string) => Promise<boolean>;

interface Ticket {
  runId: string;
  sessionId: string;
  expiresAt: number;
}

interface PreviewSession {
  runId: string;
  sessionId: string;
  expiresAt: number;
  /** 上一次確認可以查看的時間。 */
  checkedAt: number;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

export class PreviewAuth {
  private readonly tickets = new Map<string, Ticket>();
  private readonly sessions = new Map<string, PreviewSession>();

  constructor(
    private readonly clock: Clock,
    private readonly canViewRun: CanViewRun,
  ) {}

  /** authorize 已確認權限後呼叫。 */
  issueTicket(runId: string, sessionId: string): string {
    this.prune();
    const ticket = token();
    this.tickets.set(ticket, {
      runId,
      sessionId,
      expiresAt: this.now() + TICKET_TTL_MS,
    });
    return ticket;
  }

  /** 以 ticket 換成 preview session，回傳 cookie 的值；ticket 只能用一次。 */
  redeemTicket(ticket: string, runId: string): string | null {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!entry || entry.runId !== runId || entry.expiresAt <= this.now()) return null;
    const value = token();
    this.sessions.set(value, {
      runId,
      sessionId: entry.sessionId,
      expiresAt: this.now() + PREVIEW_SESSION_TTL_MS,
      // 剛在 authorize 確認過
      checkedAt: this.now(),
    });
    return value;
  }

  /** preview cookie 是否可以存取這個 Run 的 Preview。 */
  async check(cookie: string | undefined, runId: string): Promise<boolean> {
    if (!cookie) return false;
    const entry = this.sessions.get(cookie);
    if (!entry || entry.runId !== runId) return false;
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.sessions.delete(cookie);
      return false;
    }
    if (now - entry.checkedAt < ACCESS_CACHE_MS) return true;
    if (!(await this.canViewRun(entry.sessionId, runId))) {
      this.sessions.delete(cookie);
      return false;
    }
    entry.checkedAt = this.now();
    return true;
  }

  private now(): number {
    return this.clock.now().getTime();
  }

  /** 清掉過期的 ticket 與 preview session，避免一直累積。 */
  private prune(): void {
    const now = this.now();
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(key);
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
  }
}
