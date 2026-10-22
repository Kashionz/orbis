// Runner sidecar 的監管：啟動、停止、當掉時以指數退避重啟，並擷取 log 與狀態。
// 不依賴 Electron，單元測試直接用真實的子程序（fake sidecar）跑。

import { type ChildProcess, spawn } from "node:child_process";
import { Backoff, type BackoffOptions, DEFAULT_BACKOFF } from "./backoff";
import { killProcessTree } from "./process-tree";
import {
  encodeSidecarCommand,
  parseSidecarLine,
  SIDECAR_EXIT_NEEDS_PAIRING,
  type SidecarCommand,
  type SidecarStatus,
} from "./protocol";

export type SupervisorPhase =
  /** 沒有在跑，也不會自動啟動。 */
  | "stopped"
  | "running"
  /** 當掉了，等待退避時間後重啟。 */
  | "backoff"
  /** Runner 以「需要重新 Pairing」結束，等呼叫端取得新的 Pairing token 後再 start()。 */
  | "needs_pairing"
  | "stopping";

export interface SupervisorSnapshot {
  phase: SupervisorPhase;
  pid: number | null;
  /** 從第一次 start() 以來因為當掉而重啟的次數。 */
  restarts: number;
  /** 這次程序最後回報的狀態；程序結束後清空。 */
  status: SidecarStatus | null;
  lastExit: { code: number | null; signal: string | null } | null;
}

export interface SidecarLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface LogSink {
  write(chunk: string | Buffer): void;
  note(message: string): void;
}

export interface RunnerSupervisorOptions {
  /** 每次啟動時呼叫，取得指令與環境變數（Pairing token 可能已經更新）。 */
  launch: () => SidecarLaunch;
  log: LogSink;
  backoff?: BackoffOptions;
  /** 送出 shutdown 後等待 Runner 自行結束的時間，逾時就強制結束整個程序樹。 */
  shutdownTimeoutMs?: number;
  /** 每次啟動後立刻送出的指令，例如恢復「暫停領取」的狀態。 */
  initialCommands?: () => SidecarCommand[];
  killTree?: (pid: number) => Promise<void>;
  platform?: NodeJS.Platform;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
/** 強制結束後等待 exit 事件的時間。 */
const FORCE_KILL_WAIT_MS = 5_000;

type Listener = (snapshot: SupervisorSnapshot) => void;

export class RunnerSupervisor {
  private readonly backoff: Backoff;
  private readonly shutdownTimeoutMs: number;
  private readonly killTree: (pid: number) => Promise<void>;
  private readonly platform: NodeJS.Platform;
  private readonly listeners = new Set<Listener>();

  private child: ChildProcess | null = null;
  private exited: Promise<void> | null = null;
  private startedAt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping: Promise<void> | null = null;
  private state: SupervisorSnapshot = {
    phase: "stopped",
    pid: null,
    restarts: 0,
    status: null,
    lastExit: null,
  };

  constructor(private readonly options: RunnerSupervisorOptions) {
    this.backoff = new Backoff(options.backoff ?? DEFAULT_BACKOFF);
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.platform = options.platform ?? process.platform;
    this.killTree = options.killTree ?? ((pid) => killProcessTree(pid, this.platform));
  }

  snapshot(): SupervisorSnapshot {
    return this.state;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 啟動 sidecar。已經在跑或在退避中時不做任何事。launch() 丟出的例外會直接傳給呼叫端。 */
  start(): void {
    if (this.state.phase === "running" || this.state.phase === "backoff") return;
    if (this.state.phase === "stopping") {
      throw new Error("Runner 正在停止，請等 stop() 完成後再啟動");
    }
    this.backoff.reset();
    this.spawnChild();
  }

  /** 依關閉協定停止 sidecar，逾時就強制結束整個程序樹。停止後不會自動重啟。 */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.clearRestartTimer();
    const child = this.child;
    if (!child || !this.exited) {
      this.update({ phase: "stopped" });
      return Promise.resolve();
    }
    this.update({ phase: "stopping" });
    this.options.log.note("停止 Runner：送出 shutdown 並關閉 stdin");
    this.stopping = this.shutdown(child, this.exited).finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  /** 送一個指令給正在執行的 sidecar。沒有在跑時回傳 false。 */
  send(command: SidecarCommand): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    stdin.write(encodeSidecarCommand(command));
    return true;
  }

  private async shutdown(child: ChildProcess, exited: Promise<void>): Promise<void> {
    const pid = child.pid;
    this.send({ type: "shutdown" });
    child.stdin?.end();
    if (await settlesWithin(exited, this.shutdownTimeoutMs)) return;

    this.options.log.note(
      `Runner 在 ${this.shutdownTimeoutMs} ms 內沒有結束，強制結束程序樹（pid ${pid}）`,
    );
    if (pid !== undefined) await this.killTree(pid);
    if (!(await settlesWithin(exited, FORCE_KILL_WAIT_MS))) {
      child.kill("SIGKILL");
      await exited;
    }
  }

  private spawnChild(): void {
    const { command, args, env } = this.options.launch();
    this.options.log.note(`啟動 Runner：${command} ${args.join(" ")}`);
    // 參數以陣列傳入、不經過 shell。macOS／Linux 以 detached 讓 sidecar 自成 process group，
    // 強制結束時可以一次結束整個程序樹；Windows 上 detached 會另開主控台視窗，所以不用。
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: this.platform !== "win32",
    });
    this.child = child;
    this.startedAt = Date.now();
    // 程序已經結束時寫入 stdin 會 EPIPE，這種情況交給 exit 處理
    child.stdin?.on("error", () => {});
    child.stderr?.on("data", (chunk: Buffer) => this.options.log.write(chunk));
    this.readStatusLines(child);

    // exited 在 handleExit 做完（包括清掉 process group）之後才完成，stop() 等的是它
    this.exited = new Promise<void>((resolve) => {
      let settled = false;
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        void this.handleExit(child, code, signal).finally(resolve);
      };
      child.once("exit", onExit);
      child.once("error", (error) => {
        this.options.log.note(`無法啟動 Runner：${error.message}`);
        // spawn 失敗（例如找不到執行檔）時不會有 exit 事件
        if (child.pid === undefined) onExit(null, null);
      });
    });

    this.update({ phase: "running", pid: child.pid ?? null, status: null });
    for (const command of this.options.initialCommands?.() ?? []) this.send(command);
  }

  private readStatusLines(child: ChildProcess): void {
    let pending = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const status = parseSidecarLine(line);
        if (status) {
          if (this.child === child) this.update({ status });
        } else if (line.trim() !== "") {
          this.options.log.write(`${line}\n`);
        }
        newline = pending.indexOf("\n");
      }
    });
  }

  private async handleExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const pid = child.pid;
    const uptimeMs = Date.now() - this.startedAt;
    this.options.log.note(`Runner 已結束（pid ${pid}，code ${code}，signal ${signal}）`);
    if (this.child === child) {
      this.child = null;
      this.exited = null;
    }
    // macOS／Linux：Runner 結束後清掉留在 process group 裡的子孫程序
    if (pid !== undefined && this.platform !== "win32") {
      await this.killTree(pid).catch(() => {});
    }

    const lastExit = { code, signal };
    if (this.state.phase === "stopping" || this.state.phase === "stopped") {
      this.update({ phase: "stopped", pid: null, status: null, lastExit });
      return;
    }
    if (code === SIDECAR_EXIT_NEEDS_PAIRING) {
      this.update({ phase: "needs_pairing", pid: null, status: null, lastExit });
      return;
    }
    const delay = this.backoff.next(uptimeMs);
    this.options.log.note(`Runner 非預期結束，${delay} ms 後重啟`);
    this.update({ phase: "backoff", pid: null, status: null, lastExit });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.state.phase !== "backoff") return;
      this.update({ restarts: this.state.restarts + 1 });
      try {
        this.spawnChild();
      } catch (error) {
        // launch() 失敗（例如設定被清掉）時停下來，等呼叫端重新 start()
        this.options.log.note(`無法重啟 Runner：${(error as Error).message}`);
        this.update({ phase: "stopped" });
      }
    }, delay);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private update(patch: Partial<SupervisorSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}

/** promise 在 ms 內完成時回傳 true。 */
async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
