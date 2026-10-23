// GitHub App 的設定，全部從環境變數讀取。變數名稱一律用 envVar() 組出來。

import { envVar } from "@orbis/api-contract";
import { z } from "zod";

export interface GitHubAppConfig {
  /** GitHub App 的 App ID（數字）。 */
  appId: number;
  /** App 的 private key（PEM）。 */
  privateKey: string;
  /** webhook 的 secret，用來驗證 `X-Hub-Signature-256`。 */
  webhookSecret: string;
  /** App 的 slug（`https://github.com/apps/<slug>`），用來組安裝連結與辨認 App 自己的 bot 帳號。 */
  slug: string;
}

/** 每個設定項目對應的環境變數名稱。 */
export const GITHUB_APP_ENV = {
  appId: envVar("GITHUB_APP_ID"),
  privateKey: envVar("GITHUB_APP_PRIVATE_KEY"),
  webhookSecret: envVar("GITHUB_WEBHOOK_SECRET"),
  slug: envVar("GITHUB_APP_SLUG"),
} as const;

type EnvKey = keyof typeof GITHUB_APP_ENV;

export class GitHubAppConfigError extends Error {
  override name = "GitHubAppConfigError";
  constructor(readonly problems: string[]) {
    super(`GitHub App 設定有誤：\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

const required = z.string({ error: "必填" }).trim().min(1, "必填");

const EnvSchema = z.object({
  appId: required.pipe(
    z.coerce.number<string>({ error: "必須是數字" }).int("必須是整數").positive("必須是正整數"),
  ),
  privateKey: required
    // .env 檔案中常以 `\n` 跳脫換行，這裡還原成真正的換行。
    .transform((v) => v.replace(/\\n/g, "\n"))
    .refine((v) => v.includes("-----BEGIN") && v.includes("PRIVATE KEY-----"), {
      error: "必須是 PEM 格式的 private key",
    }),
  webhookSecret: required,
  slug: required.regex(/^[a-z0-9][a-z0-9-]*$/, { error: "必須是 App 的 slug（小寫英數與 -）" }),
} satisfies Record<EnvKey, z.ZodType>);

/**
 * 從環境變數讀取 GitHub App 設定。四個變數都沒設定時回傳 null（GitHub 整合停用）；
 * 只設定了一部分或格式錯誤時丟出 GitHubAppConfigError，訊息列出每個有問題的變數。
 */
export function loadGitHubAppConfig(env: NodeJS.ProcessEnv): GitHubAppConfig | null {
  const raw = Object.fromEntries(
    Object.entries(GITHUB_APP_ENV).map(([key, name]) => [key, env[name]?.trim() || undefined]),
  );
  if (Object.values(raw).every((v) => v === undefined)) return null;

  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GitHubAppConfigError(
      parsed.error.issues.map((issue) => {
        const name = GITHUB_APP_ENV[issue.path[0] as EnvKey];
        return `${name}：${issue.message}`;
      }),
    );
  }
  return parsed.data;
}
