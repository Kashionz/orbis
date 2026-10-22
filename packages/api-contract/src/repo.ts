// Repo（ARCHITECTURE §4）：登記在 Project 底下的一個 GitHub repository。

import { z } from "zod";
import { Id, Timestamp } from "./common";

export const Repo = z.object({
  id: Id,
  projectId: Id,
  /** GitHub 上的擁有者（使用者或組織）。 */
  owner: z.string().min(1),
  /** GitHub 上的 repository 名稱。 */
  name: z.string().min(1),
  defaultBranch: z.string().min(1),
  createdAt: Timestamp,
  updatedAt: Timestamp,
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

/** 登記 Repo（Admin 以上）。 */
export const CreateRepoInput = z
  .object({
    owner: GitHubOwnerName,
    name: GitHubRepoName,
    defaultBranch: GitBranchName.default("main"),
  })
  .strict();
export type CreateRepoInput = z.input<typeof CreateRepoInput>;
