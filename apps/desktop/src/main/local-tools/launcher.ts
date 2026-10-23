// 執行 LaunchSpec：程序和 Desktop 脫鉤（detached、unref），Desktop 結束後編輯器與終端機繼續開著。

import { spawn } from "node:child_process";
import type { LaunchSpec } from "./command";

export type LaunchOutcome = { ok: true } | { ok: false; message: string };

export type Launcher = (spec: LaunchSpec) => Promise<LaunchOutcome>;

export const spawnLauncher: Launcher = (spec) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env ? { ...process.env, ...spec.env } : process.env,
        detached: true,
        stdio: "ignore",
        windowsHide: spec.windowsHide,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });
    } catch (error) {
      resolve({ ok: false, message: `無法啟動 ${spec.command}：${(error as Error).message}` });
      return;
    }
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
    child.once("error", (error) => {
      resolve({ ok: false, message: `無法啟動 ${spec.command}：${error.message}` });
    });
  });
