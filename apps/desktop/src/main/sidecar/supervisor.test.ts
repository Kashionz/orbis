// 監管邏輯的測試：用真實的子程序（e2e/fixtures/fake-sidecar.mjs）跑，不 mock child_process。

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isProcessAlive } from "./process-tree";
import { SIDECAR_EXIT_NEEDS_PAIRING } from "./protocol";
import { type LogSink, RunnerSupervisor, type SupervisorSnapshot } from "./supervisor";

const FAKE_SIDECAR = fileURLToPath(new URL("./test-fixtures/fake-sidecar.mjs", import.meta.url));
const FAST_BACKOFF = { initialMs: 50, maxMs: 200, resetAfterMs: 60_000 };

class MemoryLog implements LogSink {
  text = "";
  write(chunk: string | Buffer) {
    this.text += chunk.toString();
  }
  note(message: string) {
    this.text += `[desktop] ${message}\n`;
  }
}

interface Spawned {
  pid: number;
  grandchildPid: number | null;
  pairingToken: string | null;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function waitFor<T>(check: () => T | undefined | null | false, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待逾時：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const supervisors: RunnerSupervisor[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(fakeArgs: string[] = [], options: { shutdownTimeoutMs?: number } = {}) {
  const record = mkdtempSync(join(tmpdir(), "desktop-sidecar-"));
  dirs.push(record);
  const log = new MemoryLog();
  let token = "pt_1";
  const commands: { type: "pause_claiming" }[] = [];
  const supervisor = new RunnerSupervisor({
    launch: () => ({
      command: process.execPath,
      args: [FAKE_SIDECAR, `--record=${record}`, ...fakeArgs, "--sidecar"],
      env: { ...process.env, TEST_PAIRING_TOKEN: token },
    }),
    log,
    backoff: FAST_BACKOFF,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5_000,
    initialCommands: () => commands,
  });
  supervisors.push(supervisor);
  const spawns = () => readJsonl<Spawned>(join(record, "spawns.jsonl"));
  const received = () => readJsonl<{ type: string }>(join(record, "commands.jsonl"));
  return {
    supervisor,
    log,
    spawns,
    received,
    setToken: (t: string) => {
      token = t;
    },
    pauseOnStart: () => commands.push({ type: "pause_claiming" }),
  };
}

const connected = (s: SupervisorSnapshot) => s.status?.state === "connected";

describe("RunnerSupervisor", () => {
  it("啟動後讀取狀態行，其他輸出寫進 log", async () => {
    const { supervisor, log } = setup(["--active-runs=3"]);
    supervisor.start();
    await waitFor(() => connected(supervisor.snapshot()), "已連線");
    expect(supervisor.snapshot()).toMatchObject({
      phase: "running",
      status: { runner_id: "fake-runner-id", active_runs: 3, claiming_paused: false },
    });
    await waitFor(() => log.text.includes("這一行不是狀態 JSON"), "stdout 的一般輸出");
    expect(log.text).toContain("fake sidecar 啟動");
    expect(log.text).not.toContain('"type":"status"');
  });

  it("當掉後以退避重啟，並帶著最新的 launch 設定", async () => {
    const { supervisor, spawns, setToken } = setup();
    supervisor.start();
    const [first] = await waitFor(() => spawns().length === 1 && spawns(), "第一次啟動");
    setToken("pt_2");
    process.kill(first?.pid ?? 0, "SIGKILL");
    const all = await waitFor(() => spawns().length === 2 && spawns(), "重啟");
    expect(all[1]?.pid).not.toBe(first?.pid);
    await waitFor(() => connected(supervisor.snapshot()), "重啟後已連線");
    expect(supervisor.snapshot()).toMatchObject({ phase: "running", restarts: 1 });
  });

  it("stop() 依關閉協定結束 sidecar 與它的孫程序，之後不會重啟", async () => {
    const { supervisor, spawns, received } = setup(["--grandchild"]);
    supervisor.start();
    const [spawned] = await waitFor(() => spawns().length === 1 && spawns(), "啟動");
    await waitFor(() => connected(supervisor.snapshot()), "已連線");
    await supervisor.stop();
    expect(supervisor.snapshot().phase).toBe("stopped");
    expect(received().map((c) => c.type)).toContain("shutdown");
    expect(isProcessAlive(spawned?.pid ?? 0)).toBe(false);
    await waitFor(() => !isProcessAlive(spawned?.grandchildPid ?? 0), "孫程序結束");
    await new Promise((r) => setTimeout(r, FAST_BACKOFF.maxMs * 2));
    expect(spawns()).toHaveLength(1);
  });

  it("sidecar 不理會 shutdown 時，逾時後強制結束整個程序樹", async () => {
    const { supervisor, spawns, log } = setup(["--grandchild", "--ignore-shutdown"], {
      shutdownTimeoutMs: 300,
    });
    supervisor.start();
    const [spawned] = await waitFor(() => spawns().length === 1 && spawns(), "啟動");
    await supervisor.stop();
    expect(log.text).toContain("強制結束程序樹");
    expect(isProcessAlive(spawned?.pid ?? 0)).toBe(false);
    await waitFor(() => !isProcessAlive(spawned?.grandchildPid ?? 0), "孫程序結束");
  });

  it("以「需要重新 Pairing」的結束碼結束時不自動重啟", async () => {
    const { supervisor, spawns } = setup([`--exit-code=${SIDECAR_EXIT_NEEDS_PAIRING}`]);
    supervisor.start();
    await waitFor(() => supervisor.snapshot().phase === "needs_pairing", "needs_pairing");
    await new Promise((r) => setTimeout(r, FAST_BACKOFF.maxMs * 2));
    expect(spawns()).toHaveLength(1);
    expect(supervisor.snapshot().lastExit?.code).toBe(SIDECAR_EXIT_NEEDS_PAIRING);
  });

  it("其他非 0 結束碼（例如參數錯誤的 2）視為當掉並重啟", async () => {
    const { supervisor, spawns } = setup(["--exit-code=2"]);
    supervisor.start();
    await waitFor(() => spawns().length >= 2, "重啟");
    expect(supervisor.snapshot().restarts).toBeGreaterThanOrEqual(1);
  });

  it("啟動後送出 initialCommands，send() 轉送指令", async () => {
    const { supervisor, received, pauseOnStart } = setup();
    pauseOnStart();
    supervisor.start();
    await waitFor(() => supervisor.snapshot().status?.claiming_paused, "暫停狀態");
    expect(supervisor.send({ type: "resume_claiming" })).toBe(true);
    await waitFor(
      () => supervisor.snapshot().status?.claiming_paused === false,
      "恢復領取後的狀態",
    );
    expect(received().map((c) => c.type)).toEqual(["pause_claiming", "resume_claiming"]);
  });

  it("重啟時 launch() 失敗就停下來，不會變成未捕捉的例外", async () => {
    const log = new MemoryLog();
    let calls = 0;
    const supervisor = new RunnerSupervisor({
      launch: () => {
        calls += 1;
        if (calls > 1) throw new Error("沒有 Pairing token");
        return { command: process.execPath, args: ["-e", "process.exit(1)"], env: process.env };
      },
      log,
      backoff: FAST_BACKOFF,
    });
    supervisors.push(supervisor);
    supervisor.start();
    await waitFor(() => supervisor.snapshot().phase === "stopped" && calls === 2, "停下來");
    expect(log.text).toContain("無法重啟 Runner：沒有 Pairing token");
  });

  it("找不到執行檔時進入退避，不會丟出例外", async () => {
    const log = new MemoryLog();
    const supervisor = new RunnerSupervisor({
      launch: () => ({ command: join(tmpdir(), "does-not-exist-runner"), args: [], env: {} }),
      log,
      backoff: FAST_BACKOFF,
    });
    supervisors.push(supervisor);
    supervisor.start();
    await waitFor(() => supervisor.snapshot().phase === "backoff", "backoff");
    expect(log.text).toContain("無法啟動 Runner");
    await supervisor.stop();
    expect(supervisor.snapshot().phase).toBe("stopped");
  });
});
