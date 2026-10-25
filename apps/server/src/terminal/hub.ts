// 互動式終端機的轉送（ADR-0014、ARCHITECTURE §6.5）：Web 的 WebSocket ↔ Server ↔ Runner 通道。
//
// - terminal_id 綁定開啟者的 session：只有那個 session 能接上 WebSocket（只能接一次），只轉送那個人的輸入。
// - WebSocket 關閉就關閉終端機（送 terminal_close），不支援重新接上；開啟後 30 秒內沒有接上也關閉。
// - Server 只記錄誰在什麼時候開、關（terminal_sessions），不記錄按鍵與輸出。
// - 每個 Run 同時開著的數量以記憶體中的連線計算（Server 重新啟動後，舊的紀錄以 runner_shutdown 結束）。

import type { TerminalServerMessage } from "@orbis/api-contract";
import type { TerminalExited, TerminalExitReason, TerminalOutput } from "@orbis/protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { Clock } from "../clock";
import type { Database } from "../db/client";
import { terminalSessions } from "../db/schema";
import type { Logger } from "../logger";
import type { RunnerHub } from "../runner/hub";

/** 開啟後等 WebSocket 接上的時間。 */
export const TERMINAL_CONNECT_TIMEOUT_MS = 30_000;

/** Web 端的連線（terminal/endpoint.ts）。 */
export interface TerminalSocket {
  send(message: TerminalServerMessage): void;
  close(): void;
}

interface OpenTerminal {
  id: string;
  runId: string;
  memberId: string;
  runnerId: string;
  /** 開啟者的 Orbis session。 */
  sessionId: string;
  socket: TerminalSocket | null;
  connectTimer: NodeJS.Timeout | null;
  /** 已送出 terminal_close、等 Runner 回 terminal_exited。 */
  closing: boolean;
}

export class TerminalHub {
  private readonly terminals = new Map<string, OpenTerminal>();
  private readonly log: Logger;

  constructor(
    private readonly deps: { db: Database; hub: RunnerHub; clock: Clock; logger: Logger },
    private readonly connectTimeoutMs = TERMINAL_CONNECT_TIMEOUT_MS,
  ) {
    this.log = deps.logger.child({ component: "terminal" });
  }

  /** 這個 Run 目前開著的終端機數量。 */
  activeCount(runId: string): number {
    let count = 0;
    for (const terminal of this.terminals.values()) if (terminal.runId === runId) count++;
    return count;
  }

  /** Server 啟動時：上次沒有關閉的紀錄一律結束（連線都已不存在）。 */
  async closeStale(): Promise<void> {
    await this.deps.db
      .update(terminalSessions)
      .set({ closedAt: this.deps.clock.now(), closeReason: "runner_shutdown" })
      .where(isNull(terminalSessions.closedAt));
  }

  /** 送出 terminal_open。呼叫前已寫入 terminal_sessions、確認 Runner 在線。 */
  open(input: {
    terminalId: string;
    runId: string;
    memberId: string;
    runnerId: string;
    sessionId: string;
    cols: number;
    rows: number;
  }): boolean {
    const terminal: OpenTerminal = {
      id: input.terminalId,
      runId: input.runId,
      memberId: input.memberId,
      runnerId: input.runnerId,
      sessionId: input.sessionId,
      socket: null,
      connectTimer: null,
      closing: false,
    };
    this.terminals.set(terminal.id, terminal);
    terminal.connectTimer = setTimeout(() => {
      if (!terminal.socket) void this.close(terminal.id, "closed");
    }, this.connectTimeoutMs);
    const sent = this.deps.hub.send(input.runnerId, {
      type: "terminal_open",
      terminal_id: input.terminalId,
      run_id: input.runId,
      cols: input.cols,
      rows: input.rows,
    });
    if (!sent) void this.finish(terminal.id, null, "runner_shutdown");
    return sent;
  }

  /** WebSocket 接上：只接受開啟者的 session，而且只能接一次。 */
  attach(terminalId: string, sessionId: string, socket: TerminalSocket): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.socket || terminal.closing || terminal.sessionId !== sessionId) {
      return false;
    }
    terminal.socket = socket;
    if (terminal.connectTimer) clearTimeout(terminal.connectTimer);
    terminal.connectTimer = null;
    return true;
  }

  /** 開著的終端機（定期重新確認權限用）。 */
  info(terminalId: string): { runId: string; sessionId: string } | null {
    const terminal = this.terminals.get(terminalId);
    return terminal ? { runId: terminal.runId, sessionId: terminal.sessionId } : null;
  }

  /** 登出或 session 結束：這個 session 開的終端機全部關閉。 */
  async closeSession(sessionId: string): Promise<void> {
    const ids = [...this.terminals.values()]
      .filter((t) => t.sessionId === sessionId)
      .map((t) => t.id);
    for (const id of ids) await this.close(id, "closed");
  }

  /** 這個 session 可以接上（是開啟者、還沒有連線、沒有在關閉）。 */
  canAttach(terminalId: string, sessionId: string): boolean {
    const terminal = this.terminals.get(terminalId);
    return terminal?.sessionId === sessionId && !terminal.socket && !terminal.closing;
  }

  input(terminalId: string, data: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.closing) return;
    this.deps.hub.send(terminal.runnerId, {
      type: "terminal_input",
      terminal_id: terminalId,
      data,
    });
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.closing) return;
    this.deps.hub.send(terminal.runnerId, {
      type: "terminal_resize",
      terminal_id: terminalId,
      cols,
      rows,
    });
  }

  /** 使用者關閉（WebSocket 關閉或沒有接上）：送 terminal_close，Runner 不在線時直接結束。 */
  async close(terminalId: string, reason: TerminalExitReason): Promise<void> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.closing) return;
    terminal.closing = true;
    terminal.socket = null;
    const sent = this.deps.hub.send(terminal.runnerId, {
      type: "terminal_close",
      terminal_id: terminalId,
    });
    if (!sent) await this.finish(terminalId, null, reason);
  }

  /** Runner 的 terminal_output：只接受這台 Runner 開的終端機。 */
  onOutput(runnerId: string, frame: TerminalOutput): void {
    const terminal = this.terminals.get(frame.terminal_id);
    if (terminal?.runnerId !== runnerId) return;
    terminal.socket?.send({ type: "output", data: frame.data });
  }

  /** Runner 的 terminal_exited：轉給 Web、關閉 WebSocket、記下關閉的時間與原因。 */
  async onExited(runnerId: string, frame: TerminalExited): Promise<void> {
    const terminal = this.terminals.get(frame.terminal_id);
    if (terminal?.runnerId !== runnerId) return;
    await this.finish(frame.terminal_id, frame.code, frame.reason);
  }

  /** Runner 斷線：它的終端機全部以 runner_shutdown 結束。 */
  async onRunnerDisconnect(runnerId: string): Promise<void> {
    const ids = [...this.terminals.values()]
      .filter((t) => t.runnerId === runnerId)
      .map((t) => t.id);
    for (const id of ids) await this.finish(id, null, "runner_shutdown");
  }

  /** 所有連線關閉（Server 關閉時）。 */
  closeAll(): void {
    for (const terminal of this.terminals.values()) {
      if (terminal.connectTimer) clearTimeout(terminal.connectTimer);
      terminal.socket?.close();
    }
    this.terminals.clear();
  }

  private async finish(
    terminalId: string,
    code: number | null,
    reason: TerminalExitReason,
  ): Promise<void> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    this.terminals.delete(terminalId);
    if (terminal.connectTimer) clearTimeout(terminal.connectTimer);
    if (terminal.socket) {
      terminal.socket.send({ type: "exited", code, reason });
      terminal.socket.close();
    }
    try {
      await this.deps.db
        .update(terminalSessions)
        .set({ closedAt: this.deps.clock.now(), closeReason: reason })
        .where(and(eq(terminalSessions.id, terminalId), isNull(terminalSessions.closedAt)));
    } catch (error) {
      this.log.warn({ err: error, terminalId }, "記錄終端機關閉失敗");
    }
  }
}
