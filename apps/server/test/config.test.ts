import path from "node:path";
import { envVar, NAMES } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_BLOB_DIR,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PUBLIC_URL,
  DEFAULT_SERVER_PORT,
  loadConfig,
} from "../src/config";

const REQUIRED = {
  [envVar("DATABASE_URL")]: "postgres://user:pass@localhost:5432/db",
  [envVar("GITHUB_CLIENT_ID")]: "client-id",
  [envVar("GITHUB_CLIENT_SECRET")]: "client-secret",
};

function configError(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("預期 loadConfig 失敗");
}

describe("Server 設定", () => {
  it("只給必填項目時套用預設值", () => {
    const config = loadConfig({ ...REQUIRED, NODE_ENV: "production" });
    expect(config).toEqual({
      databaseUrl: REQUIRED[envVar("DATABASE_URL")],
      port: DEFAULT_SERVER_PORT,
      publicUrl: DEFAULT_PUBLIC_URL,
      apiOrigin: `http://localhost:${DEFAULT_SERVER_PORT}`,
      github: { clientId: "client-id", clientSecret: "client-secret" },
      bootstrapOwnerGithubUserId: null,
      devPairingToken: null,
      runnerHeartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      blobDir: DEFAULT_BLOB_DIR,
      previewDomain: null,
      webDir: null,
      smtp: null,
      logLevel: "info",
      prettyLogs: false,
    });
    expect(DEFAULT_SERVER_PORT).toBe(4000);
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(15_000);
  });

  it("缺少必填項目時，錯誤訊息列出每個環境變數的完整名稱", () => {
    const error = configError({});
    expect(error.problems).toEqual([
      `${envVar("DATABASE_URL")}：必填`,
      `${envVar("GITHUB_CLIENT_ID")}：必填`,
      `${envVar("GITHUB_CLIENT_SECRET")}：必填`,
    ]);
    expect(error.message).toContain(envVar("DATABASE_URL"));
  });

  it("空字串視為未設定", () => {
    const error = configError({ ...REQUIRED, [envVar("GITHUB_CLIENT_ID")]: "  " });
    expect(error.problems).toEqual([`${envVar("GITHUB_CLIENT_ID")}：必填`]);
    const config = loadConfig({ ...REQUIRED, [envVar("DEV_PAIRING_TOKEN")]: "" });
    expect(config.devPairingToken).toBeNull();
  });

  it("bootstrap owner 必須是數字 user id，填 login 時提示查詢方式", () => {
    const error = configError({ ...REQUIRED, [envVar("BOOTSTRAP_OWNER")]: "octocat" });
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toContain(envVar("BOOTSTRAP_OWNER"));
    expect(error.problems[0]).toContain("user id");
  });

  it("格式錯誤時拒絕", () => {
    const error = configError({
      ...REQUIRED,
      [envVar("DATABASE_URL")]: "mysql://localhost/db",
      [envVar("SERVER_PORT")]: "70000",
      [envVar("PUBLIC_URL")]: "not a url",
      [envVar("RUNNER_HEARTBEAT_INTERVAL_MS")]: "10",
      [envVar("LOG_LEVEL")]: "loud",
    });
    expect(error.problems.map((p) => p.split("：")[0])).toEqual([
      envVar("DATABASE_URL"),
      envVar("SERVER_PORT"),
      envVar("PUBLIC_URL"),
      envVar("RUNNER_HEARTBEAT_INTERVAL_MS"),
      envVar("LOG_LEVEL"),
    ]);
  });

  it("Server port 只看 SERVER_PORT，不使用注入 Worktree 的 Preview port", () => {
    const config = loadConfig({ ...REQUIRED, [NAMES.env.port]: "5999" });
    expect(config.port).toBe(DEFAULT_SERVER_PORT);
    expect(loadConfig({ ...REQUIRED, [envVar("SERVER_PORT")]: "4100" }).port).toBe(4100);
  });

  it("讀取選填項目，並去掉 PUBLIC_URL 結尾的斜線", () => {
    const config = loadConfig({
      ...REQUIRED,
      [envVar("PUBLIC_URL")]: "https://example.test/",
      [envVar("BOOTSTRAP_OWNER")]: "583231",
      [envVar("DEV_PAIRING_TOKEN")]: "pt_dev",
      [envVar("RUNNER_HEARTBEAT_INTERVAL_MS")]: "5000",
    });
    expect(config.publicUrl).toBe("https://example.test");
    expect(config.bootstrapOwnerGithubUserId).toBe(583231);
    expect(config.devPairingToken).toBe("pt_dev");
    expect(config.runnerHeartbeatIntervalMs).toBe(5000);
  });

  it("API origin：未設定時是本機的 Server port，設定時只取 origin", () => {
    expect(loadConfig({ ...REQUIRED, [envVar("SERVER_PORT")]: "4100" }).apiOrigin).toBe(
      "http://localhost:4100",
    );
    expect(
      loadConfig({ ...REQUIRED, [envVar("API_ORIGIN")]: "https://api.example.test/" }).apiOrigin,
    ).toBe("https://api.example.test");
    expect(configError({ ...REQUIRED, [envVar("API_ORIGIN")]: "ftp://x" }).problems[0]).toContain(
      envVar("API_ORIGIN"),
    );
  });

  it("易讀 log：未指定時依 NODE_ENV 決定，LOG_PRETTY 可以覆寫", () => {
    expect(loadConfig({ ...REQUIRED }).prettyLogs).toBe(true);
    expect(loadConfig({ ...REQUIRED, NODE_ENV: "production" }).prettyLogs).toBe(false);
    expect(loadConfig({ ...REQUIRED, [envVar("LOG_PRETTY")]: "0" }).prettyLogs).toBe(false);
    expect(
      loadConfig({ ...REQUIRED, NODE_ENV: "production", [envVar("LOG_PRETTY")]: "1" }).prettyLogs,
    ).toBe(true);
  });

  it("Web 的靜態檔目錄轉成絕對路徑；未設定時為 null", () => {
    expect(loadConfig({ ...REQUIRED, [envVar("WEB_DIR")]: "web" }).webDir).toBe(
      path.resolve("web"),
    );
    expect(loadConfig({ ...REQUIRED, [envVar("WEB_DIR")]: "" }).webDir).toBeNull();
  });
});
