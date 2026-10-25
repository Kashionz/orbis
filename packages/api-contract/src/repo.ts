// Repo（ARCHITECTURE §4）：登記在 Project 底下的一個 GitHub repository，或本機 git repository
// （本機 Repo，ADR-0013）。

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { RepoKind } from "./enums";

export const Repo = z
  .object({
    id: Id,
    projectId: Id,
    kind: RepoKind,
    /** GitHub 上的擁有者（使用者或組織）；本機 Repo 為 null。 */
    owner: z.string().min(1).nullable(),
    /** GitHub 上的 repository 名稱，或本機 Repo 的名稱（Runner 的 `runner.toml` 以此對應 checkout）。 */
    name: z.string().min(1),
    /** 基準分支。本機 Repo 核准後合併到這裡。 */
    defaultBranch: z.string().min(1),
    /**
     * GitHub App 在這個 repo 的安裝狀態，由 installation webhook 即時更新（§11）；本機 Repo 為 null。
     */
    github: z
      .object({
        installed: z.boolean(),
        /** 還沒安裝時，給使用者安裝 App 的網址；已安裝時為 null。 */
        installUrl: z.url().nullable(),
      })
      .nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .refine((repo) => (repo.kind === "github") === (repo.owner !== null && repo.github !== null), {
    error: "GitHub Repo 必須有 owner 與 github；本機 Repo 兩者都是 null",
    path: ["owner"],
  });
export type Repo = z.infer<typeof Repo>;

/** GitHub 的使用者或組織名稱。 */
export const GitHubOwnerName = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, { error: "不是合法的 GitHub 使用者或組織名稱" });

/** GitHub 的 repository 名稱；不可以是 `.` 或 `..`（Runner 會把它用在 Worktree 路徑中）。 */
export const GitHubRepoName = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, { error: "不是合法的 GitHub repository 名稱" })
  .refine((name) => name !== "." && name !== "..", { error: "不是合法的 GitHub repository 名稱" });

/** git 分支名稱（git check-ref-format 規則的子集合；會被放進 git 指令的參數）。 */
export const GitBranchName = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      !name.startsWith("-") &&
      !name.startsWith("/") &&
      !name.endsWith("/") &&
      !name.endsWith(".") &&
      !name.endsWith(".lock") &&
      !name.includes("..") &&
      !name.includes("//") &&
      !name.includes("@{") &&
      name !== "@" &&
      !name.split("/").some((part) => part.startsWith(".")) &&
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 要排除的正是控制字元
      !/[\u0000- \u007f~^:?*[\\]/.test(name),
    { error: "不是合法的 git 分支名稱" },
  );

/** 控制字元，以及 Windows 路徑不允許的字元。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 要排除的正是控制字元
const FORBIDDEN_LOCAL_NAME_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/;

/** Windows 的保留裝置名稱（不分大小寫，含副檔名時也一樣）。 */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * 本機 Repo 的名稱。不套用 GitHub 的命名規則，但會用在 Worktree 路徑與 `runner.toml` 的 key 中，所以：
 * 1–100 個字元；不含 `/ \ : * ? " < > |` 與控制字元；不以 `.` 或 `-` 開頭；不以 `.` 或空白結尾；
 * 不是 Windows 的保留名稱（`CON`、`NUL`、`COM1` 等）。
 */
export const LocalRepoName = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (name) =>
      !FORBIDDEN_LOCAL_NAME_CHARS.test(name) &&
      !name.startsWith(".") &&
      !name.startsWith("-") &&
      !name.endsWith(".") &&
      !name.endsWith(" ") &&
      !WINDOWS_RESERVED_NAMES.test(name),
    { error: "不是合法的本機 Repo 名稱" },
  );

/**
 * 登記 Repo（Admin 以上），以 `kind` 區分（省略時是 `github`，和 API 版本 1 相容）：
 * - `github`：GitHub App 已安裝時，Server 從 GitHub 讀取 default branch；還沒安裝時用 `defaultBranch`，
 *   沒有指定就用 `main`（§11）。
 * - `local`：本機 Repo，只有名稱，Server 不保存路徑；基準分支用 `defaultBranch`，沒有指定就用 `main`。
 */
export const CreateRepoInput = z.union([
  z
    .object({
      kind: z.literal("github").default("github"),
      owner: GitHubOwnerName,
      name: GitHubRepoName,
      defaultBranch: GitBranchName.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("local"),
      name: LocalRepoName,
      defaultBranch: GitBranchName.optional(),
    })
    .strict(),
]);
export type CreateRepoInput = z.input<typeof CreateRepoInput>;

/**
 * 把本機 Repo 改成 GitHub Repo（`POST` repoConnectGithub，`manage_project`，只能單向）。
 * 前置條件：本機 checkout 的 `origin` 指向這個 GitHub repo，而且基準分支已 push；Orbis 不幫忙建立 GitHub repo。
 * - GitHub App 沒有安裝在這個 repo 上 → 409 `repo_not_connected`（附 `installUrl`）。
 * - 同一個 Project 已經登記了這個 GitHub repo → 409 `repo_exists`。
 * 成功回更新後的 `Repo`。
 */
export const ConnectRepoToGithubInput = z
  .object({ owner: GitHubOwnerName, name: GitHubRepoName })
  .strict();
export type ConnectRepoToGithubInput = z.infer<typeof ConnectRepoToGithubInput>;
