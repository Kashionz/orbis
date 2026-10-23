// Repo Spec 提交到 repo（ARCHITECTURE §12.1）：把 UI 中共同編輯的草稿 commit 到新的分支並開 PR，
// PR merge 之後更新 Repo Spec 的版本。

import { randomBytes } from "node:crypto";
import { NAMES } from "@orbis/api-contract";
import { GitHubApiError } from "./client/types";
import { connectedRepo, type IntegrationContext } from "./context";
import { REPO_SPEC_PULL_REQUEST_MARKER } from "./markdown";
import type { MemberRecord, RepoSpecPullRequest, RepoSpecRecord } from "./ports";
import type { PullRequestPayload } from "./webhook/payloads";

export interface CommitRepoSpecInput {
  repoSpecId: string;
  /** 草稿的 markdown（Server 從共同編輯的文件取出）。 */
  markdown: string;
  requesterMemberId: string;
  /** commit 訊息；沒有指定時用 `docs(spec): 更新 <路徑>`。 */
  message?: string;
}

export type CommitRepoSpecResult =
  | {
      ok: true;
      pullRequest: { number: number; url: string };
      /** 這次新開了 PR（false：沿用這份 Spec 還開著的 PR）。 */
      created: boolean;
      /** 這次的 commit；草稿與分支上的內容相同、沒有 commit 時為 null。 */
      commitSha: string | null;
      /**
       * repo 中的檔案在上一次提交之後被別人改過：PR 會覆蓋那些修改（照常開 PR，由 review 決定）。
       */
      overwritesRepoChanges: boolean;
    }
  | {
      ok: false;
      /**
       * `disabled`：Server 沒有提供 Repo Spec 的依賴。
       * `forbidden`：提出請求的人不是能在這個 Project 編輯 Task 的 Member。
       * `invalid_path`：不是能提交的路徑（見 `isCommittableSpecPath`）。
       */
      reason:
        | "disabled"
        | "spec_not_found"
        | "invalid_path"
        | "forbidden"
        | "repo_not_connected"
        | "github_error";
      message: string;
    };

/**
 * 能從 Orbis 提交的 Spec 路徑：repo 內的相對路徑、`.md` 檔、不在 `.github/` 底下。
 * App 有 contents 的寫入權限，不能讓 Repo Spec 變成改動任意檔案的管道。
 */
export function isCommittableSpecPath(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\")) return false;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  if (segments[0]?.toLowerCase() === ".github") return false;
  return /\.md$/i.test(path);
}

/** Spec PR 的分支名稱：`<產品>/spec/<檔名>-<亂數>`。 */
export function repoSpecBranchName(path: string, suffix: string): string {
  const file = path.split("/").pop() ?? "";
  const slug = file
    .replace(/\.[^.]*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${NAMES.productSlug}/spec/${slug || "spec"}-${suffix}`;
}

function coAuthor(member: MemberRecord): string {
  return `Co-authored-by: ${member.githubLogin} <${member.githubUserId}+${member.githubLogin}@users.noreply.github.com>`;
}

function renderSpecPullRequestBody(input: {
  spec: RepoSpecRecord;
  requester: MemberRecord;
  overwritesRepoChanges: boolean;
}): string {
  const { spec } = input;
  const lines = [
    REPO_SPEC_PULL_REQUEST_MARKER,
    `由 ${NAMES.productName} 提交的 Repo Spec 草稿：\`${spec.path}\``,
    "",
    `- 目前的版本：v${spec.version}（merge 後成為 v${spec.version + 1}）`,
    `- 提交者：@${input.requester.githubLogin}`,
  ];
  if (input.overwritesRepoChanges) {
    lines.push(
      "",
      `> [!WARNING]\n> repo 中的 \`${spec.path}\` 在上一次從 ${NAMES.productName} 提交之後被修改過，這個 PR 會覆蓋那些修改。`,
    );
  }
  return lines.join("\n");
}

/**
 * 把 Repo Spec 的草稿提交到 repo：從 default branch 開分支、commit 該 markdown 檔、以 App 身分開 PR。
 * 同一份 Spec 已經有開著的 PR 時，在同一個分支上再 commit 一次並沿用 PR（重複送出是安全的）。
 */
export async function commitRepoSpec(
  ctx: IntegrationContext,
  input: CommitRepoSpecInput,
): Promise<CommitRepoSpecResult> {
  const deps = ctx.repoSpecs;
  if (!deps) {
    return { ok: false, reason: "disabled", message: "Server 沒有啟用 Repo Spec 提交" };
  }
  const spec = await deps.getRepoSpec(input.repoSpecId);
  if (!spec) return { ok: false, reason: "spec_not_found", message: "Repo Spec 不存在" };
  if (!isCommittableSpecPath(spec.path)) {
    return {
      ok: false,
      reason: "invalid_path",
      message: `只能提交 repo 內 .github/ 以外的 .md 檔：${spec.path}`,
    };
  }
  const record = await ctx.domain.getRepo(spec.repoId);
  if (!record) return { ok: false, reason: "spec_not_found", message: "Repo Spec 的 Repo 不存在" };

  // 路由的 Role 檢查由 Server 負責；這裡另外確認提出者能在這個 Project 編輯 Task。
  const requester = await ctx.domain.getMember(input.requesterMemberId);
  const member =
    requester &&
    (await ctx.domain.findMemberByGithubUserId(record.projectId, requester.githubUserId));
  if (
    !requester ||
    member?.id !== requester.id ||
    !(await ctx.domain.canEditTasks(record.projectId, requester.id))
  ) {
    return { ok: false, reason: "forbidden", message: "沒有權限提交這份 Repo Spec" };
  }
  const repo = connectedRepo(record);
  if (!repo) {
    return { ok: false, reason: "repo_not_connected", message: "Repo 沒有安裝 GitHub App" };
  }

  return ctx.taskLocks.run(`repo-spec:${spec.id}`, async (): Promise<CommitRepoSpecResult> => {
    try {
      const { installationId, ref } = repo;
      let base = record.defaultBranch;
      if (!base) {
        const info = await ctx.client.getRepo(installationId, ref);
        if (!info) throw new GitHubApiError(404, "讀不到 Repo 的 default branch");
        base = info.defaultBranch;
        await ctx.domain.updateRepoGitHubInfo(record.id, { defaultBranch: base });
      }

      // 還開著的 Spec PR：沿用它的分支（GitHub 上已經關閉的不算）。
      let existing = await deps.store.findOpenRepoSpecPullRequest(spec.id);
      if (existing) {
        const pr = await ctx.client.findOpenPullRequest(installationId, ref, existing.headBranch);
        if (!pr) {
          await deps.store.saveRepoSpecPullRequest({ ...existing, state: "closed" });
          existing = null;
        }
      }

      const baseFile = await ctx.client.getFileContent(installationId, ref, spec.path, base);
      const overwritesRepoChanges =
        spec.committedBlobSha !== null && (baseFile?.sha ?? null) !== spec.committedBlobSha;

      let branch: string;
      let current: { sha: string; content: string } | null;
      if (existing) {
        branch = existing.headBranch;
        current = await ctx.client.getFileContent(installationId, ref, spec.path, branch);
      } else {
        const head = await ctx.client.getBranchHead(installationId, ref, base);
        if (!head) throw new GitHubApiError(404, `找不到 default branch ${base}`);
        branch = repoSpecBranchName(spec.path, randomBytes(3).toString("hex"));
        await ctx.client.createBranch(installationId, ref, branch, head);
        current = baseFile;
      }

      let commitSha: string | null = null;
      if (current?.content !== input.markdown) {
        const subject = input.message?.trim() || `docs(spec): 更新 ${spec.path}`;
        const result = await ctx.client.putFile(installationId, ref, {
          path: spec.path,
          branch,
          message: `${subject}\n\n${coAuthor(requester)}`,
          content: input.markdown,
          ...(current ? { sha: current.sha } : {}),
        });
        commitSha = result.commitSha;
      }

      let pr = await ctx.client.findOpenPullRequest(installationId, ref, branch);
      const created = pr === null;
      if (!pr) {
        pr = await ctx.client.createPullRequest(installationId, ref, {
          title: `docs(spec): 更新 ${spec.path}`,
          head: branch,
          base,
          body: renderSpecPullRequestBody({ spec, requester, overwritesRepoChanges }),
        });
      }
      const link: RepoSpecPullRequest = {
        repoSpecId: spec.id,
        githubRepoId: repo.githubRepoId,
        number: pr.number,
        url: pr.htmlUrl,
        headBranch: branch,
        state: "open",
        createdByMemberId: existing?.createdByMemberId ?? requester.id,
      };
      await deps.store.saveRepoSpecPullRequest(link);
      ctx.logger.info(
        { repoSpecId: spec.id, pullRequest: pr.htmlUrl, created, commitSha },
        "已提交 Repo Spec",
      );
      return {
        ok: true,
        pullRequest: { number: pr.number, url: pr.htmlUrl },
        created,
        commitSha,
        overwritesRepoChanges,
      };
    } catch (error) {
      if (!(error instanceof GitHubApiError)) throw error;
      ctx.logger.error({ err: error, repoSpecId: spec.id }, "提交 Repo Spec 失敗");
      return { ok: false, reason: "github_error", message: error.message };
    }
  });
}

export type RepoSpecPullRequestOutcome =
  | { kind: "ignored"; reason: "unhandled_action" | "already_handled" }
  | { kind: "merged"; repoSpecId: string; version: number }
  | { kind: "closed"; repoSpecId: string }
  | { kind: "reopened"; repoSpecId: string };

/**
 * Spec PR 的 `pull_request` 事件：merge → 版本 +1，記錄 merge commit 與檔案的 blob SHA；
 * 沒有 merge 就關閉 → 只記錄 PR 狀態，版本不變；重新打開 → 回到 open。
 */
export async function handleRepoSpecPullRequestEvent(
  ctx: IntegrationContext,
  spr: RepoSpecPullRequest,
  payload: PullRequestPayload,
): Promise<RepoSpecPullRequestOutcome> {
  const deps = ctx.repoSpecs;
  if (!deps) return { kind: "ignored", reason: "unhandled_action" };
  if (payload.action !== "closed" && payload.action !== "reopened") {
    return { kind: "ignored", reason: "unhandled_action" };
  }
  return ctx.taskLocks.run(`repo-spec:${spr.repoSpecId}`, async () => {
    const current = (await deps.store.findRepoSpecPullRequest(spr.githubRepoId, spr.number)) ?? spr;
    const merged = payload.action === "closed" && payload.pull_request.merged === true;
    const next = payload.action === "reopened" ? "open" : merged ? "merged" : "closed";
    if (current.state === next || current.state === "merged") {
      return { kind: "ignored", reason: "already_handled" } as const;
    }
    await deps.store.saveRepoSpecPullRequest({ ...current, state: next });
    if (!merged) {
      return payload.action === "closed"
        ? ({ kind: "closed", repoSpecId: current.repoSpecId } as const)
        : ({ kind: "reopened", repoSpecId: current.repoSpecId } as const);
    }

    const commitSha = payload.pull_request.merge_commit_sha ?? payload.pull_request.head.sha;
    const spec = await deps.getRepoSpec(current.repoSpecId);
    const record = spec && (await ctx.domain.getRepo(spec.repoId));
    const repo = record && connectedRepo(record);
    const file =
      spec && repo
        ? await ctx.client.getFileContent(repo.installationId, repo.ref, spec.path, commitSha)
        : null;
    const { version } = await deps.recordRepoSpecMerged(current.repoSpecId, {
      commitSha,
      blobSha: file?.sha ?? null,
      pullRequestUrl: current.url,
    });
    ctx.logger.info(
      { repoSpecId: current.repoSpecId, pullRequest: current.url, version },
      "Repo Spec 的 PR 已 merge，版本更新",
    );
    return { kind: "merged", repoSpecId: current.repoSpecId, version } as const;
  });
}
