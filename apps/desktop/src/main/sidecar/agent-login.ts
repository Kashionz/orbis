// Agent 重新登入（後端缺口 agent-relogin）：在這台電腦上執行 Runner 的登入子指令 `<Runner> login <agent>`，
// 由 Agent 自己開瀏覽器。用 sidecar 同一個 Runner 執行檔與狀態目錄，登入標記才會寫在 sidecar 看得到的地方；
// sidecar 在下一次 Heartbeat 發現標記改變，重新回報可用性（ARCHITECTURE §7）。
//
// - Agent id 只接受小寫英數與 `-`，參數以陣列傳給 spawn，不經過 shell。
// - 不帶 Pairing token 與 Server 網址：登入不需要連 Server。
// - 同一個 Agent 同時只跑一個登入；重複呼叫等同一個結果。
// - Runner 自己 10 分鐘就放棄；Desktop 另設稍長的保險逾時，時間到就結束整個程序樹。

import type { DesktopActionResult } from "../../bridge";
import { DESKTOP_ENV, RUNNER_ENV } from "../names";
import type { RunnerCommand } from "./runner-command";

/** Agent Profile 的 id。 */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Runner 的 `login` 子指令自己的逾時是 10 分鐘，Desktop 多等 1 分鐘。 */
export const LOGIN_TIMEOUT_MS = 11 * 60 * 1000;

/** 失敗時附在訊息中的 stderr 行數。 */
const STDERR_TAIL_LINES = 10;

export interface LoginLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function buildLoginLaunch(input: {
  command: RunnerCommand;
  baseEnv: NodeJS.ProcessEnv;
  stateDir: string;
  agentId: string;
}): LoginLaunch {
  const env: NodeJS.ProcessEnv = { ...input.baseEnv };
  for (const name of Object.values(DESKTOP_ENV)) delete env[name];
  delete env[RUNNER_ENV.pairingToken];
  delete env[RUNNER_ENV.serverUrl];
  env[RUNNER_ENV.stateDir] = input.stateDir;
  return {
    command: input.command.command,
    args: [...input.command.args, "login", input.agentId],
    env,
  };
}

/** 執行中的登入程序（spawn 的最小介面，測試可以替換）。 */
export interface LoginProcess {
  pid?: number;
  onStderr(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null, error?: Error) => void): void;
}

export interface AgentLoginDeps {
  command: () => RunnerCommand;
  baseEnv: NodeJS.ProcessEnv;
  stateDir: string;
  spawn: (launch: LoginLaunch) => LoginProcess;
  killTree: (pid: number) => Promise<void>;
  timeoutMs?: number;
}

export class AgentLogin {
  private readonly running = new Map<string, Promise<DesktopActionResult>>();

  constructor(private readonly deps: AgentLoginDeps) {}

  login(agentId: unknown): Promise<DesktopActionResult> {
    if (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId)) {
      return Promise.resolve({ ok: false, message: "Agent 的 id 不合法" });
    }
    const existing = this.running.get(agentId);
    if (existing) return existing;
    const result = this.run(agentId).finally(() => this.running.delete(agentId));
    this.running.set(agentId, result);
    return result;
  }

  private run(agentId: string): Promise<DesktopActionResult> {
    let launch: LoginLaunch;
    try {
      launch = buildLoginLaunch({
        command: this.deps.command(),
        baseEnv: this.deps.baseEnv,
        stateDir: this.deps.stateDir,
        agentId,
      });
    } catch (error) {
      return Promise.resolve({ ok: false, message: (error as Error).message });
    }
    return new Promise((resolve) => {
      let stderr = "";
      let settled = false;
      const finish = (result: DesktopActionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      let child: LoginProcess;
      try {
        child = this.deps.spawn(launch);
      } catch (error) {
        resolve({ ok: false, message: `無法執行登入指令：${(error as Error).message}` });
        return;
      }
      const timer = setTimeout(() => {
        if (child.pid !== undefined) void this.deps.killTree(child.pid);
        finish({ ok: false, message: `${agentId} 的登入逾時，請再試一次` });
      }, this.deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
      child.onStderr((chunk) => {
        stderr += chunk;
      });
      child.onExit((code, error) => {
        if (error) {
          finish({ ok: false, message: `無法執行登入指令：${error.message}` });
          return;
        }
        if (code === 0) {
          finish({ ok: true });
          return;
        }
        const tail = stderr.trim().split(/\r?\n/).slice(-STDERR_TAIL_LINES).join("\n");
        finish({
          ok: false,
          message: tail ? `${agentId} 登入失敗：${tail}` : `${agentId} 登入失敗（結束碼 ${code}）`,
        });
      });
    });
  }
}
