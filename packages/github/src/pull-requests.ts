// 開 PR（Review Gate 核准、Runner push 完成後）與 PR 關閉的處理（ARCHITECTURE §5、§11）。

import { senderCanWrite } from "./authz";
import { GitHubApiError } from "./client/types";
import { connectedRepo, type IntegrationContext, taskOwner } from "./context";
import { pushTask } from "./issues/sync";
import { pullRequestTitle, renderPullRequestBody } from "./markdown";
import type { PullRequestLink } from "./ports";
import type { PullRequestPayload } from "./webhook/payloads";

export interface BranchPushed {
  taskId: string;
  runId: string;
  /** Runner 回報的 `branch_pushed.branch`。 */
  branch: string;
  /** Runner 回報的 `branch_pushed.commit_sha`。 */
  commitSha: string;
}

export type OpenPullRequestResult =
  | { ok: true; number: number; url: string; created: boolean }
  | {
      ok: false;
      reason: "task_not_found" | "no_repo" | "repo_not_connected" | "github_error";
      message: string;
    };

/** Repo 內 Spec 檔在 GitHub 上的網址（以 PR 的分支為準）。 */
function specUrl(owner: string, name: string, branch: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${owner}/${name}/blob/${encodeURIComponent(branch)}/${encodedPath}`;
}

/**
 * 以 App 身分開 PR：head 是 Run 的分支，base 是 Repo 的 default branch。
 * 同一個分支已經有開著的 PR 時沿用它，不會重開（重複呼叫是安全的）。
 * GitHub 回錯時通知 Task 的負責人。
 */
export async function openPullRequest(
  ctx: IntegrationContext,
  pushed: BranchPushed,
): Promise<OpenPullRequestResult> {
  const task = await ctx.domain.getTask(pushed.taskId);
  if (!task) return { ok: false, reason: "task_not_found", message: "Task 不存在" };
  if (!task.repoId) return { ok: false, reason: "no_repo", message: "Task 沒有對應的 Repo" };
  const record = await ctx.domain.getRepo(task.repoId);
  const repo = record && connectedRepo(record);
  if (!repo) {
    return { ok: false, reason: "repo_not_connected", message: "Repo 沒有安裝 GitHub App" };
  }

  try {
    let base = repo.record.defaultBranch;
    if (!base) {
      const info = await ctx.client.getRepo(repo.installationId, repo.ref);
      if (!info) throw new GitHubApiError(404, "讀不到 Repo 的 default branch");
      base = info.defaultBranch;
      await ctx.domain.updateRepoGitHubInfo(repo.record.id, { defaultBranch: base });
    }

    let pr = await ctx.client.findOpenPullRequest(repo.installationId, repo.ref, pushed.branch);
    const created = pr === null;
    if (!pr) {
      const [criteria, issueLink] = await Promise.all([
        ctx.domain.listAcceptanceCriteria(task.id),
        ctx.store.getIssueLinkByTask(task.id),
      ]);
      pr = await ctx.client.createPullRequest(repo.installationId, repo.ref, {
        title: pullRequestTitle(task),
        head: pushed.branch,
        base,
        body: renderPullRequestBody({
          task,
          taskUrl: ctx.taskUrl(task),
          criteria,
          specUrl: task.specPath
            ? specUrl(repo.ref.owner, repo.ref.name, pushed.branch, task.specPath)
            : null,
          issueNumber: issueLink?.githubRepoId === repo.githubRepoId ? issueLink.issueNumber : null,
        }),
      });
      ctx.logger.info({ taskId: task.id, pullRequest: pr.htmlUrl }, "已開 PR");
    }

    const link: PullRequestLink = {
      taskId: task.id,
      runId: pushed.runId,
      repoId: repo.record.id,
      githubRepoId: repo.githubRepoId,
      number: pr.number,
      url: pr.htmlUrl,
      headBranch: pushed.branch,
      headSha: pushed.commitSha,
      state: "open",
    };
    await ctx.store.savePullRequestLink(link);
    return { ok: true, number: pr.number, url: pr.htmlUrl, created };
  } catch (error) {
    if (!(error instanceof GitHubApiError)) throw error;
    ctx.logger.error({ err: error, taskId: task.id }, "開 PR 失敗");
    const owner = taskOwner(task);
    if (owner) {
      await ctx.notifier.notify({
        memberId: owner,
        kind: "pr_open_failed",
        taskId: task.id,
        message: `${task.key} 開 PR 失敗：${error.message}`,
      });
    }
    return { ok: false, reason: "github_error", message: error.message };
  }
}

export type PullRequestEventOutcome =
  | { kind: "ignored"; reason: "unhandled_action" | "not_linked" | "already_handled" }
  | { kind: "merged"; taskId: string; transitioned: boolean }
  | { kind: "closed"; taskId: string; transitioned: boolean }
  | { kind: "reopened"; taskId: string; transitioned: boolean }
  /** 沒有寫入權限的人關閉或重開 PR：Task 不轉換，通知負責人。 */
  | { kind: "rejected"; taskId: string; reason: "sender_not_authorized" };

/**
 * `pull_request.closed`：merged → Task 轉 Done；沒有 merge 就關閉 → 退回 Review Gate 並通知負責人。
 * `pull_request.reopened`：回到 PR Open。只處理以 App 開出、有對應 Task 的 PR。
 *
 * 沒有 merge 的關閉與重開，和 Issue 一樣只採用能編輯 Task 的 Member 或對 repo 有寫入權限的人
 * （GitHub 上 triage 角色也能關閉、重開 PR）。merge 本身就需要寫入權限。
 */
export async function handlePullRequestEvent(
  ctx: IntegrationContext,
  payload: PullRequestPayload,
): Promise<PullRequestEventOutcome> {
  if (payload.action !== "closed" && payload.action !== "reopened") {
    return { kind: "ignored", reason: "unhandled_action" };
  }
  const link = await ctx.store.findPullRequestLink(payload.repository.id, payload.number);
  if (!link) return { kind: "ignored", reason: "not_linked" };

  return ctx.taskLocks.run(
    `pr:${link.githubRepoId}:${link.number}`,
    async (): Promise<PullRequestEventOutcome> => {
      // 重新讀取：同一個 PR 的 webhook 可能同時到達。
      const current = (await ctx.store.findPullRequestLink(link.githubRepoId, link.number)) ?? link;
      const pullRequestUrl = payload.pull_request.html_url;
      const merged = payload.action === "closed" && payload.pull_request.merged === true;
      const nextState = payload.action === "reopened" ? "open" : merged ? "merged" : "closed";
      if (current.state === nextState || current.state === "merged") {
        return { kind: "ignored", reason: "already_handled" } as const;
      }

      const task = await ctx.domain.getTask(current.taskId);
      if (!task) return { kind: "ignored", reason: "not_linked" } as const;

      const owner = taskOwner(task);
      if (
        !merged &&
        !(await senderCanWrite(
          ctx,
          task.projectId,
          current.repoId,
          payload.sender.login,
          payload.sender.id,
        ))
      ) {
        // PR 的狀態照實記錄，Task 維持原狀；由負責人決定要不要處理。
        await ctx.store.savePullRequestLink({ ...current, state: nextState });
        if (owner) {
          await ctx.notifier.notify({
            memberId: owner,
            kind: "pr_closed_unmerged",
            taskId: task.id,
            message: `${task.key} 的 PR 被沒有寫入權限的 @${payload.sender.login} ${
              payload.action === "closed" ? "關閉" : "重新打開"
            }，Task 維持原狀態`,
            url: pullRequestUrl,
          });
        }
        ctx.logger.warn(
          { taskId: task.id, pullRequest: pullRequestUrl, sender: payload.sender.login },
          "沒有寫入權限的人變更了 PR 狀態，Task 不轉換",
        );
        return { kind: "rejected", taskId: task.id, reason: "sender_not_authorized" } as const;
      }

      let transitioned: boolean;
      if (merged) {
        const result = await ctx.domain.transitionTask(task.id, "done", {
          kind: "pr_merged",
          doneReason: "completed",
          pullRequestUrl,
        });
        transitioned = result.ok;
        if (owner) {
          await ctx.notifier.notify({
            memberId: owner,
            kind: "pr_merged",
            taskId: task.id,
            message: `${task.key} 的 PR 已 merge，Task 轉為 Done`,
            url: pullRequestUrl,
          });
        }
      } else if (payload.action === "closed") {
        const result = await ctx.domain.transitionTask(task.id, "review_gate", {
          kind: "pr_closed",
          pullRequestUrl,
          byGithubLogin: payload.sender.login,
        });
        transitioned = result.ok;
        if (owner) {
          await ctx.notifier.notify({
            memberId: owner,
            kind: "pr_closed_unmerged",
            taskId: task.id,
            message: `${task.key} 的 PR 被 @${payload.sender.login} 關閉（沒有 merge），Task 退回 Review Gate`,
            url: pullRequestUrl,
          });
        }
      } else {
        const result = await ctx.domain.transitionTask(task.id, "pr_open", {
          kind: "pr_reopened",
          pullRequestUrl,
        });
        transitioned = result.ok;
      }

      await ctx.store.savePullRequestLink({ ...current, state: nextState });
      // 由 GitHub 觸發的轉換 Server 不會回呼 onTaskChanged，這裡自己同步 Issue 與摘要留言。
      await pushTask(ctx, task.id);
      ctx.logger.info(
        { taskId: task.id, pullRequest: pullRequestUrl, state: nextState, transitioned },
        "已處理 PR 狀態變更",
      );
      const kind = merged ? "merged" : payload.action === "closed" ? "closed" : "reopened";
      return { kind, taskId: task.id, transitioned };
    },
  );
}
