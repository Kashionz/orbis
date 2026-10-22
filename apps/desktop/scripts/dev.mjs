#!/usr/bin/env node
// 開發模式：`cargo build` Runner（Desktop 開發模式使用 target/debug 的產物）並打包 Desktop，再啟動 Electron。
// 會載入 repo 根目錄的 .env（例如 <前綴>RUNNER_SERVER_URL）。

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

function run(command, args, cwd) {
  // 參數以陣列傳給 spawn，不經過 shell
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ["scripts/build.mjs", "--with-runner"], desktopDir);

// electron 套件匯出的是 Electron 執行檔的路徑
const electron = createRequire(import.meta.url)("electron");
const child = spawn(electron, ["."], { cwd: desktopDir, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
