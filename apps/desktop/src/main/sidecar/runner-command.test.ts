import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_ENV, RUNNER_ENV, runnerBinaryName } from "../names";
import { SIDECAR_FLAG } from "./protocol";
import { buildRunnerLaunch, resolveRunnerCommand } from "./runner-command";

const ctx = {
  env: {},
  isPackaged: false,
  resourcesPath: join("/app", "resources"),
  appPath: join("/repo", "apps", "desktop"),
  platform: "win32" as const,
};

describe("resolveRunnerCommand", () => {
  it("開發模式用 repo 根目錄 cargo build 的產物", () => {
    expect(resolveRunnerCommand(ctx)).toEqual({
      command: join("/repo", "target", "debug", runnerBinaryName("win32")),
      args: [],
    });
    expect(runnerBinaryName("win32")).toMatch(/-runner\.exe$/);
    expect(runnerBinaryName("linux")).toMatch(/-runner$/);
  });

  it("打包模式用 resources/bin 內建的執行檔", () => {
    expect(resolveRunnerCommand({ ...ctx, isPackaged: true, platform: "darwin" })).toEqual({
      command: join("/app", "resources", "bin", runnerBinaryName("darwin")),
      args: [],
    });
  });

  it("環境變數覆寫整個指令，格式錯誤時明確報錯", () => {
    const env = { [DESKTOP_ENV.runnerCommand]: JSON.stringify(["node", "fake.mjs", "--x"]) };
    expect(resolveRunnerCommand({ ...ctx, env })).toEqual({
      command: "node",
      args: ["fake.mjs", "--x"],
    });
    for (const bad of ["node fake.mjs", "[]", "[1]", '"node"']) {
      expect(() =>
        resolveRunnerCommand({ ...ctx, env: { [DESKTOP_ENV.runnerCommand]: bad } }),
      ).toThrow(DESKTOP_ENV.runnerCommand);
    }
  });
});

describe("buildRunnerLaunch", () => {
  it("以環境變數傳遞 Server URL、Pairing token 與狀態目錄，並加上 sidecar 旗標", () => {
    const launch = buildRunnerLaunch({
      command: { command: "runner", args: ["--name", "x"] },
      baseEnv: { PATH: "/bin", [DESKTOP_ENV.testHooks]: "1", [RUNNER_ENV.pairingToken]: "old" },
      serverUrl: "http://localhost:4000",
      pairingToken: "pt_new",
      stateDir: "/data/runner",
    });
    expect(launch.command).toBe("runner");
    expect(launch.args).toEqual(["--name", "x", SIDECAR_FLAG]);
    expect(launch.args.join(" ")).not.toContain("pt_new");
    expect(launch.env).toEqual({
      PATH: "/bin",
      [RUNNER_ENV.serverUrl]: "http://localhost:4000",
      [RUNNER_ENV.pairingToken]: "pt_new",
      [RUNNER_ENV.stateDir]: "/data/runner",
    });
  });
});
