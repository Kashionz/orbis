import { describe, expect, it, vi } from "vitest";
import { DESKTOP_ENV, RUNNER_ENV } from "../names";
import {
  AgentLogin,
  type AgentLoginDeps,
  buildLoginLaunch,
  type LoginLaunch,
  type LoginProcess,
} from "./agent-login";

/** 可以由測試決定何時結束的登入程序。 */
function fakeProcess(pid = 42) {
  let stderr: ((chunk: string) => void) | undefined;
  let exit: ((code: number | null, error?: Error) => void) | undefined;
  const process: LoginProcess = {
    pid,
    onStderr: (listener) => {
      stderr = listener;
    },
    onExit: (listener) => {
      exit = listener;
    },
  };
  return {
    process,
    stderr: (chunk: string) => stderr?.(chunk),
    exit: (code: number | null, error?: Error) => exit?.(code, error),
  };
}

function deps(overrides: Partial<AgentLoginDeps> = {}) {
  const spawned: LoginLaunch[] = [];
  const child = fakeProcess();
  const base: AgentLoginDeps = {
    command: () => ({ command: "/app/bin/runner", args: ["--extra"] }),
    baseEnv: { PATH: "/bin" },
    stateDir: "/user-data/runner",
    spawn: (launch) => {
      spawned.push(launch);
      return child.process;
    },
    killTree: vi.fn(async () => {}),
    ...overrides,
  };
  return { deps: base, spawned, child };
}

describe("buildLoginLaunch", () => {
  it("以 sidecar 的執行檔與狀態目錄執行 login，不帶 Pairing token 與 Desktop 自己的設定", () => {
    const launch = buildLoginLaunch({
      command: { command: "/app/bin/runner", args: ["--extra"] },
      baseEnv: {
        PATH: "/bin",
        [RUNNER_ENV.pairingToken]: "pt_secret",
        [RUNNER_ENV.serverUrl]: "https://orbis.example.com",
        [DESKTOP_ENV.testHooks]: "1",
      },
      stateDir: "/user-data/runner",
      agentId: "antigravity",
    });
    expect(launch.command).toBe("/app/bin/runner");
    expect(launch.args).toEqual(["--extra", "login", "antigravity"]);
    expect(launch.env[RUNNER_ENV.stateDir]).toBe("/user-data/runner");
    expect(launch.env.PATH).toBe("/bin");
    expect(launch.env).not.toHaveProperty(RUNNER_ENV.pairingToken);
    expect(launch.env).not.toHaveProperty(RUNNER_ENV.serverUrl);
    expect(launch.env).not.toHaveProperty(DESKTOP_ENV.testHooks);
  });
});

describe("AgentLogin", () => {
  it("結束碼 0 時成功", async () => {
    const { deps: d, spawned, child } = deps();
    const result = new AgentLogin(d).login("antigravity");
    child.exit(0);
    await expect(result).resolves.toEqual({ ok: true });
    expect(spawned[0]?.args).toEqual(["--extra", "login", "antigravity"]);
  });

  it("失敗時附上 stderr 的最後幾行", async () => {
    const { deps: d, child } = deps();
    const result = new AgentLogin(d).login("antigravity");
    child.stderr("INFO 啟動 Agent\n");
    child.stderr("Error: antigravity 登入失敗：使用者取消了登入\n");
    child.exit(1);
    const outcome = await result;
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toContain("使用者取消了登入");
  });

  it("無法啟動時回傳錯誤", async () => {
    const { deps: d, child } = deps();
    const result = new AgentLogin(d).login("antigravity");
    child.exit(null, new Error("ENOENT"));
    const outcome = await result;
    expect(outcome.ok === false && outcome.message).toContain("ENOENT");
  });

  it("拒絕不合法的 Agent id，不執行任何程序", async () => {
    const { deps: d, spawned } = deps();
    const login = new AgentLogin(d);
    for (const bad of ["", "../x", "Antigravity", "a b", "a;rm", 42, null]) {
      const outcome = await login.login(bad);
      expect(outcome.ok).toBe(false);
    }
    expect(spawned).toHaveLength(0);
  });

  it("同一個 Agent 同時只跑一個登入", async () => {
    const { deps: d, spawned, child } = deps();
    const login = new AgentLogin(d);
    const first = login.login("antigravity");
    const second = login.login("antigravity");
    expect(spawned).toHaveLength(1);
    child.exit(0);
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    // 結束後可以再登入一次。
    void login.login("antigravity");
    expect(spawned).toHaveLength(2);
  });

  it("逾時時結束整個程序樹", async () => {
    vi.useFakeTimers();
    try {
      const killTree = vi.fn(async () => {});
      const { deps: d } = deps({ killTree, timeoutMs: 1000 });
      const result = new AgentLogin(d).login("antigravity");
      await vi.advanceTimersByTimeAsync(1000);
      const outcome = await result;
      expect(outcome.ok === false && outcome.message).toContain("逾時");
      expect(killTree).toHaveBeenCalledWith(42);
    } finally {
      vi.useRealTimers();
    }
  });
});
