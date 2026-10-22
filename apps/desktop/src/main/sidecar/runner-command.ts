// 決定要用哪個 Runner 執行檔：
// - 打包模式：App 內建的 `resources/bin/<runner>`。
// - 開發模式：repo 根目錄 `cargo build` 的產物 `target/debug/<runner>`。
// - 測試與開發可以用 DESKTOP_ENV.runnerCommand（JSON 字串陣列）覆寫整個指令。

import { join } from "node:path";
import { DESKTOP_ENV, RUNNER_ENV, runnerBinaryName } from "../names";
import { SIDECAR_FLAG } from "./protocol";
import type { SidecarLaunch } from "./supervisor";

export interface RunnerCommandContext {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  /** 打包後的 `process.resourcesPath`。 */
  resourcesPath: string;
  /** `app.getAppPath()`，開發模式下是 apps/desktop。 */
  appPath: string;
  platform: NodeJS.Platform;
}

export type RunnerCommand = { command: string; args: string[] };

export function resolveRunnerCommand(ctx: RunnerCommandContext): RunnerCommand {
  const override = ctx.env[DESKTOP_ENV.runnerCommand];
  if (override) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(override);
    } catch {
      parsed = null;
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((part) => typeof part === "string")
    ) {
      throw new Error(`${DESKTOP_ENV.runnerCommand} 必須是非空的 JSON 字串陣列`);
    }
    const [command, ...args] = parsed as string[];
    return { command: command as string, args };
  }
  const binary = runnerBinaryName(ctx.platform);
  if (ctx.isPackaged) return { command: join(ctx.resourcesPath, "bin", binary), args: [] };
  return { command: join(ctx.appPath, "..", "..", "target", "debug", binary), args: [] };
}

export interface RunnerLaunchInput {
  command: RunnerCommand;
  baseEnv: NodeJS.ProcessEnv;
  /** Runner 要連線的 Server（Web UI 的 origin，或 DESKTOP_ENV.runnerServerUrl 覆寫）。 */
  serverUrl: string;
  pairingToken: string;
  stateDir: string;
}

/** 組出 sidecar 的啟動參數。Pairing token 以環境變數傳遞，不出現在命令列上。 */
export function buildRunnerLaunch(input: RunnerLaunchInput): SidecarLaunch {
  const env: NodeJS.ProcessEnv = { ...input.baseEnv };
  // Desktop 自己的設定不傳給 Runner
  for (const name of Object.values(DESKTOP_ENV)) delete env[name];
  env[RUNNER_ENV.serverUrl] = input.serverUrl;
  env[RUNNER_ENV.pairingToken] = input.pairingToken;
  env[RUNNER_ENV.stateDir] = input.stateDir;
  return {
    command: input.command.command,
    args: [...input.command.args, SIDECAR_FLAG],
    env,
  };
}
