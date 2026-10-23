// 登入與 Pairing（使用者核准的決定 D1、D2）：
// - main 程序監看 Server 的 session cookie，有變化就呼叫 refresh()，以 `/api/auth/me` 確認登入狀態。
// - 登入（而且是某個 Team 的 Member）後取得 Local Runner 的 Pairing token，交給 sidecar 啟動。
// - 登出（cookie 消失或 /me 回 401）時停止 sidecar 並刪除本機的 Runner 狀態。
//   Server 端的 Runner 由 Server 在 logout 時撤銷（B1）。
// 不依賴 Electron，Cookie 與 sidecar 都經由介面注入。

import type { MeResponse } from "@orbis/api-contract";
import type { ServerApi } from "./server-api";

export type SessionPhase =
  | "signed_out"
  /** 正在確認登入狀態。 */
  | "checking"
  /** 已登入，但還不是任何 Team 的 Member，不能 Pairing。 */
  | "no_team"
  /** 正在取得 Pairing token。 */
  | "pairing"
  /** 已把 Pairing token 交給 sidecar。 */
  | "paired"
  /** 無法連線到 Server 或 Pairing 失敗，稍後重試。 */
  | "error";

export interface SessionState {
  phase: SessionPhase;
  me: MeResponse | null;
  error: string | null;
}

export interface RunnerControl {
  /** 用這個 Pairing token 啟動（或重新啟動）sidecar。 */
  start(pairingToken: string): Promise<void>;
  stop(): Promise<void>;
  /** 刪除 Runner 存在本機的狀態（Runner token 等）。呼叫前 sidecar 已停止。 */
  clearState(): Promise<void>;
}

export interface SessionControllerDeps {
  api: ServerApi;
  hasSessionCookie: () => Promise<boolean>;
  runner: RunnerControl;
  log: (message: string) => void;
  /** 連線失敗後多久重試。 */
  retryDelayMs?: number;
  /** 拿到新 Pairing token 後這段時間內又被要求重新 Pairing，就判定 Pairing 失敗、不再自動重試。 */
  pairingLoopWindowMs?: number;
}

const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_PAIRING_LOOP_WINDOW_MS = 30_000;

type Listener = (state: SessionState) => void;

export class SessionController {
  private state: SessionState = { phase: "signed_out", me: null, error: null };
  private readonly listeners = new Set<Listener>();
  /** 所有狀態變更依序執行，避免 cookie 事件連續觸發時並行 Pairing。 */
  private queue: Promise<void> = Promise.resolve();
  private retryTimer: NodeJS.Timeout | null = null;
  private lastPairedAt = 0;
  /** 目前 sidecar 是替哪個 Member 啟動的；顯示用的 phase 可能因為暫時連不上 Server 變成 error，這個不會。 */
  private pairedMemberId: string | null = null;
  private disposed = false;

  constructor(private readonly deps: SessionControllerDeps) {}

  snapshot(): SessionState {
    return this.state;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 重新確認登入狀態，必要時 Pairing 或解除。回傳的 promise 在這次確認完成後完成。 */
  refresh(): Promise<void> {
    return this.enqueue(() => this.evaluate());
  }

  /** sidecar 以「需要重新 Pairing」結束時呼叫：取得新的 Pairing token 再啟動一次。 */
  runnerNeedsPairing(): Promise<void> {
    return this.enqueue(async () => {
      if (this.pairedMemberId === null || !this.state.me?.member) return;
      if (
        Date.now() - this.lastPairedAt <
        (this.deps.pairingLoopWindowMs ?? DEFAULT_PAIRING_LOOP_WINDOW_MS)
      ) {
        this.deps.log("新的 Pairing token 也被 Server 拒絕，停止自動 Pairing");
        this.pairedMemberId = null;
        await this.deps.runner.stop();
        this.update({ phase: "error", error: "Pairing 失敗，請重新登入" });
        return;
      }
      this.deps.log("Runner 需要重新 Pairing，取得新的 Pairing token");
      await this.unpairLocally();
      await this.pair(this.state.me);
    });
  }

  /**
   * 換到另一個 Server：先停止 sidecar 並刪除本機的 Runner 狀態（裡面的 Runner token 屬於前一個 Server），
   * 再套用新的 Server URL，最後重新確認登入狀態。全部在同一個 queue 中依序執行，
   * 中途不會有用前一個 Server 的 token 連到新 Server 的 Pairing 或重啟。
   */
  changeServer(apply: () => void | Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      this.clearRetry();
      this.deps.log("換到另一個 Server，停止 Runner 並刪除本機的 Runner 狀態");
      await this.unpairLocally();
      this.update({ phase: "signed_out", me: null, error: null });
      await apply();
      await this.evaluate();
    });
  }

  /** 停止 sidecar（不清除本機狀態），App 結束時使用。 */
  dispose(): Promise<void> {
    this.disposed = true;
    this.clearRetry();
    return this.enqueue(() => this.deps.runner.stop());
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  private async evaluate(): Promise<void> {
    if (this.disposed) return;
    this.clearRetry();
    if (!(await this.deps.hasSessionCookie())) {
      await this.signOut();
      return;
    }
    if (this.state.phase === "signed_out") this.update({ phase: "checking" });

    let me: MeResponse | null;
    try {
      me = await this.deps.api.me();
    } catch (error) {
      this.fail(`無法確認登入狀態：${messageOf(error)}`);
      return;
    }
    if (!me) {
      await this.signOut();
      return;
    }

    if (!me.member) {
      if (this.pairedMemberId !== null) await this.unpairLocally();
      this.update({ phase: "no_team", me, error: null });
      return;
    }
    if (this.pairedMemberId === me.member.id) {
      this.update({ phase: "paired", me, error: null });
      return;
    }
    if (this.pairedMemberId !== null) {
      // 換了一個人登入（沒有經過登出）：舊的 Runner 狀態屬於前一個人
      this.deps.log("登入的 Member 變了，解除前一個 Member 的 Pairing");
      await this.unpairLocally();
    }
    await this.pair(me);
  }

  private async pair(me: MeResponse): Promise<void> {
    this.update({ phase: "pairing", me, error: null });
    try {
      const { token } = await this.deps.api.createLocalPairingToken();
      await this.deps.runner.start(token);
      this.pairedMemberId = me.member?.id ?? null;
      this.lastPairedAt = Date.now();
      this.deps.log(`已取得 Pairing token，啟動 Runner（Member ${me.member?.id}）`);
      this.update({ phase: "paired", error: null });
    } catch (error) {
      this.fail(`取得 Pairing token 失敗：${messageOf(error)}`);
    }
  }

  private async signOut(): Promise<void> {
    if (this.state.phase === "signed_out") return;
    this.deps.log("偵測到登出，停止 Runner 並刪除本機的 Runner 狀態");
    await this.unpairLocally();
    this.update({ phase: "signed_out", me: null, error: null });
  }

  private async unpairLocally(): Promise<void> {
    this.pairedMemberId = null;
    await this.deps.runner.stop();
    await this.deps.runner.clearState();
  }

  private fail(message: string): void {
    this.deps.log(message);
    this.update({ phase: "error", error: message });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refresh();
    }, this.deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private update(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
