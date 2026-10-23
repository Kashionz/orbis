// Repo Spec（ARCHITECTURE §12.1）：Repo 中的 markdown Spec 檔。在 UI 中共同編輯一份草稿
// （collab 文件 `repo-spec-draft:<id>`），按下「提交到 repo」後由 GitHub App 建立分支、commit 並開 PR；
// PR merge 後版本加 1。

import { z } from "zod";
import { Id, Timestamp } from "./common";

/** 路徑中不允許的字元：控制字元，以及 Windows 不允許的 `\ : * ? " < > |`。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 要排除的正是控制字元
const FORBIDDEN_PATH_CHARS = /[\u0000-\u001f\u007f\\:*?"<>|]/;

/**
 * Repo 內的相對路徑，以 `/` 分隔，結尾是 `.md`。逐段檢查：每一段不可以是空的、`.` 或 `..`，
 * 整個路徑不可以有控制字元（會被放進 git 指令與 GitHub API 的路徑）。
 * 第一段不可以是 `.github`（不分大小寫）：那裡的檔案會改變 workflow 與 repo 設定，GitHub App 也不一定有權限。
 */
export const RepoSpecPath = z
  .string()
  .min(4)
  .max(255)
  .refine(
    (path) =>
      path.endsWith(".md") &&
      !FORBIDDEN_PATH_CHARS.test(path) &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
      path.split("/")[0]?.toLowerCase() !== ".github",
    { error: "Spec 路徑必須是 repo 內以 / 分隔的相對路徑，結尾是 .md" },
  );

export const RepoSpec = z.object({
  id: Id,
  repoId: Id,
  path: RepoSpecPath,
  title: z.string().nullable(),
  /** 每次 Spec PR merge 加 1；還沒有任何 merge 時為 0。 */
  version: z.number().int().nonnegative(),
  /** 最近一次 merge 的 commit；還沒有時為 null。 */
  committedSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  /** 還沒 merge 的 Spec PR；沒有時為 null。 */
  openPullRequest: z.object({ number: z.number().int().positive(), url: z.url() }).nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type RepoSpec = z.infer<typeof RepoSpec>;

/** `GET` repoSpecs 的回應。 */
export const RepoSpecListResponse = z.array(RepoSpec);
export type RepoSpecListResponse = z.infer<typeof RepoSpecListResponse>;

/** 登記一個 Repo Spec（`POST` repoSpecs）。檔案還不存在時，提交後才會建立。 */
export const CreateRepoSpecInput = z
  .object({ path: RepoSpecPath, title: z.string().trim().min(1).nullable().default(null) })
  .strict();
export type CreateRepoSpecInput = z.input<typeof CreateRepoSpecInput>;

/** 把草稿提交到 repo（`POST` repoSpecCommit）。需要能編輯 Task 的權限。 */
export const RepoSpecCommitInput = z
  .object({ message: z.string().trim().min(1).max(200).optional() })
  .strict();
export type RepoSpecCommitInput = z.infer<typeof RepoSpecCommitInput>;

/** 提交的結果。已經有開著的 Spec PR 時更新那個 PR，`created` 為 false。 */
export const RepoSpecCommitResponse = z.object({
  pullRequest: z.object({ number: z.number().int().positive(), url: z.url() }),
  created: z.boolean(),
  /** default branch 上的檔案在上次版本之後被別人改過，PR 會覆蓋那些修改（不擋下，只警告）。 */
  overwritesUpstreamChanges: z.boolean(),
});
export type RepoSpecCommitResponse = z.infer<typeof RepoSpecCommitResponse>;
