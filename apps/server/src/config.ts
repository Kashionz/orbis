// Server 設定，全部從環境變數讀取。變數名稱一律用 envVar() 組出來。
// 注意 NAMES.env.port 是注入 Worktree 的 Preview port，Server 不能用它，所以 Server 用 SERVER_PORT。

import { fileURLToPath } from "node:url";
import { envVar } from "@orbis/api-contract";
import { z } from "zod";

export const DEFAULT_SERVER_PORT = 4000;
export const DEFAULT_PUBLIC_URL = "http://localhost:5173";
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
/** blob 的預設存放位置：apps/server/data/blobs（已列入 apps/server/.gitignore）。 */
export const DEFAULT_BLOB_DIR = fileURLToPath(new URL("../data/blobs", import.meta.url));

export interface Config {
  databaseUrl: string;
  port: number;
  /** Web 的 origin，OAuth 的 redirect_uri 與登入後導回的位置都以它為準。 */
  publicUrl: string;
  github: { clientId: string; clientSecret: string };
  /** 第一次登入時建立 Team 並成為 Owner 的 GitHub login；未設定時不會自動建立 Team。 */
  /**
   * 第一次登入時建立 Team 並成為 Owner 的 GitHub 數字 user id。
   * 用 id 而不用 login：login 可以改名，舊名稱可能被別人註冊。
   */
  bootstrapOwnerGithubUserId: number | null;
  /** 開發用的 Pairing token stub；未設定時拒絕所有 Pairing。 */
  devPairingToken: string | null;
  runnerHeartbeatIntervalMs: number;
  /** blob（大型 Event 內容、截圖）在本機檔案系統的存放目錄。 */
  blobDir: string;
  logLevel: string;
  /** 以易讀格式輸出 log（開發用）。 */
  prettyLogs: boolean;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Server 設定有誤：\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const optionalString = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const required = z.string({ error: "必填" }).trim().min(1, "必填");

const port = (fallback: number) =>
  optionalString.pipe(
    z.coerce
      .number<string | undefined>({ error: "必須是整數" })
      .int("必須是整數")
      .min(1, "必須介於 1 到 65535")
      .max(65535, "必須介於 1 到 65535")
      .default(fallback),
  );

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** 每個設定項目對應的環境變數名稱。 */
export const CONFIG_ENV = {
  databaseUrl: envVar("DATABASE_URL"),
  port: envVar("SERVER_PORT"),
  publicUrl: envVar("PUBLIC_URL"),
  githubClientId: envVar("GITHUB_CLIENT_ID"),
  githubClientSecret: envVar("GITHUB_CLIENT_SECRET"),
  bootstrapOwnerGithubUserId: envVar("BOOTSTRAP_OWNER"),
  devPairingToken: envVar("DEV_PAIRING_TOKEN"),
  runnerHeartbeatIntervalMs: envVar("RUNNER_HEARTBEAT_INTERVAL_MS"),
  blobDir: envVar("BLOB_DIR"),
  logLevel: envVar("LOG_LEVEL"),
  logPretty: envVar("LOG_PRETTY"),
} as const;

type EnvKey = keyof typeof CONFIG_ENV;

const EnvSchema = z.object({
  databaseUrl: required.pipe(
    z.url({ protocol: /^postgres(ql)?$/, error: "必須是 postgres:// 開頭的連線字串" }),
  ),
  port: port(DEFAULT_SERVER_PORT),
  publicUrl: optionalString.pipe(
    z.url({ protocol: /^https?$/, error: "必須是 http(s) 網址" }).default(DEFAULT_PUBLIC_URL),
  ),
  githubClientId: required,
  githubClientSecret: required,
  bootstrapOwnerGithubUserId: optionalString.pipe(
    z.coerce
      .number<string | undefined>({
        error: "必須是 GitHub 的數字 user id（可用 `gh api user --jq .id` 查詢），不是 login",
      })
      .int("必須是 GitHub 的數字 user id")
      .positive("必須是 GitHub 的數字 user id")
      .optional(),
  ),
  devPairingToken: optionalString,
  runnerHeartbeatIntervalMs: optionalString.pipe(
    z.coerce
      .number<string | undefined>({ error: "必須是整數" })
      .int("必須是整數")
      .min(1000, "至少 1000")
      .default(DEFAULT_HEARTBEAT_INTERVAL_MS),
  ),
  blobDir: optionalString,
  logLevel: optionalString.pipe(z.enum(LOG_LEVELS).default("info")),
  logPretty: optionalString.pipe(z.enum(["0", "1"]).optional()),
} satisfies Record<EnvKey, z.ZodType>);

/**
 * 從環境變數讀取並驗證設定。缺少或格式錯誤時丟出 ConfigError，訊息列出每個有問題的變數。
 * 未指定 LOG_PRETTY 時，NODE_ENV 不是 production 就用易讀格式。
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const raw = Object.fromEntries(Object.entries(CONFIG_ENV).map(([key, name]) => [key, env[name]]));
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const name = CONFIG_ENV[issue.path[0] as EnvKey];
      return `${name}：${issue.message}`;
    });
    throw new ConfigError(problems);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.databaseUrl,
    port: e.port,
    publicUrl: e.publicUrl.replace(/\/+$/, ""),
    github: { clientId: e.githubClientId, clientSecret: e.githubClientSecret },
    bootstrapOwnerGithubUserId: e.bootstrapOwnerGithubUserId ?? null,
    devPairingToken: e.devPairingToken ?? null,
    runnerHeartbeatIntervalMs: e.runnerHeartbeatIntervalMs,
    blobDir: e.blobDir ?? DEFAULT_BLOB_DIR,
    logLevel: e.logLevel,
    prettyLogs: e.logPretty === undefined ? env.NODE_ENV !== "production" : e.logPretty === "1",
  };
}
