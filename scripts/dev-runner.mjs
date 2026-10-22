#!/usr/bin/env node
// 本機開發：載入 repo 根目錄的 .env 後，以 `cargo run` 啟動 Runner。
// 額外參數會原樣傳給 Runner，例如 `pnpm dev:runner -- --name my-laptop`。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const args = ["run", "-p", "orbis-runner", "--", ...process.argv.slice(2)];
// 參數以陣列傳給 spawn，不經過 shell，路徑含空白也不需要另外加引號。
const child = spawn("cargo", args, { cwd: root, stdio: "inherit" });
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
