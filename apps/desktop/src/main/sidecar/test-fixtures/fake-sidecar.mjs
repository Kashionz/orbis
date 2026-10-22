#!/usr/bin/env node
// 單元測試用的 fake sidecar（只給 supervisor.test.ts 用，e2e 一律用真實的 Runner）：
// 讓 Desktop 的監管邏輯不必等真實的 Runner 就能測試。只用於測試。
//
// 參數（Desktop 附加的 `--sidecar` 等其他參數會被忽略）：
//   --record=<目錄>       把每次啟動與收到的指令記錄到 <目錄>/spawns.jsonl、commands.jsonl
//   --grandchild          再 spawn 一個長時間執行的孫程序（測試整個程序樹都被結束）
//   --ignore-shutdown     不理會 shutdown 與 stdin EOF（測試逾時後強制結束）
//   --exit-code=<N>       輸出一次狀態後以 N 結束
//   --active-runs=<N>     回報的執行中 Run 數

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const prefix = `--${name}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
};

const recordDir = option("record");
const ignoreShutdown = flag("ignore-shutdown");
const exitCode = option("exit-code");
const activeRuns = Number(option("active-runs") ?? 0);

function record(file, value) {
  if (!recordDir) return;
  mkdirSync(recordDir, { recursive: true });
  appendFileSync(join(recordDir, file), `${JSON.stringify(value)}\n`);
}

let grandchild = null;
if (flag("grandchild")) {
  grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

// 環境變數名稱由 Desktop 以名稱常數組出，這裡只挑出以 PAIRING_TOKEN、SERVER_URL、RUNNER_STATE_DIR 結尾的值
const envSuffix = (suffix) =>
  Object.entries(process.env).find(([key]) => key.endsWith(`_${suffix}`))?.[1] ?? null;

record("spawns.jsonl", {
  pid: process.pid,
  grandchildPid: grandchild?.pid ?? null,
  args,
  pairingToken: envSuffix("PAIRING_TOKEN"),
  serverUrl: envSuffix("SERVER_URL"),
  stateDir: envSuffix("RUNNER_STATE_DIR"),
});

let claimingPaused = false;
const status = (state) => {
  process.stdout.write(
    `${JSON.stringify({
      type: "status",
      state,
      runner_id: state === "connected" ? "fake-runner-id" : null,
      active_runs: activeRuns,
      claiming_paused: claimingPaused,
    })}\n`,
  );
};

process.stderr.write(`fake sidecar 啟動（pid ${process.pid}）\n`);
status("connecting");
process.stdout.write("這一行不是狀態 JSON，應該寫進 log\n");

if (exitCode !== undefined) {
  setTimeout(() => process.exit(Number(exitCode)), 50);
} else {
  setTimeout(() => status("connected"), 100);
}

function shutdown(reason) {
  record("commands.jsonl", { type: "_shutdown", reason });
  if (ignoreShutdown) return;
  grandchild?.kill();
  process.exit(0);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  record("commands.jsonl", command);
  if (command.type === "pause_claiming" || command.type === "resume_claiming") {
    claimingPaused = command.type === "pause_claiming";
    status("connected");
  } else if (command.type === "shutdown") {
    shutdown("command");
  }
});
lines.on("close", () => shutdown("stdin_eof"));

// 保持程序存活
setInterval(() => {}, 1000);
