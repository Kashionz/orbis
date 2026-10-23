// Feedback Loop 的觸發（ARCHITECTURE §5.2）：過濾 webhook 的觸發來源，把回饋放進待送批次。
//
// - review：`pull_request_review.submitted`。有內容、`changes_requested` 或兩則以上行內留言的 review
//   送出時立刻觸發；只有一則留言的（GitHub 的「Add single comment」也會產生一份 review）算零散留言。
// - PR 對話串的留言（`issue_comment.created`）：零散留言。
// - 零散留言在最後一則之後 2 分鐘才送出，期間的留言合併成一批；之後送出的 review 會把它們一起帶走。
// - CI：`check_suite.completed` 與失敗的 `check_run.completed`。等 PR 目前 head 的 check suite 都完成，
//   再把失敗的 check run 合併成一批；同一個 check run 只觸發一次。
// - `pull_request_review_comment` 不另外處理：它在所屬的 review 之後才送到，review 送出時已經讀過留言。

import { senderCanWrite } from "../authz";
import type { GitHubUserRef } from "../client/types";
import { connectedRepo, type IntegrationContext, isOwnEcho } from "../context";
import type {
  CiFeedbackItem,
  FeedbackBatch,
  FeedbackDependencies,
  PullRequestLink,
  ReviewFeedbackItem,
  TaskRecord,
} from "../ports";
import type {
  CheckRunPayload,
  CheckSuitePayload,
  IssueCommentPayload,
  PullRequestReviewPayload,
} from "../webhook/payloads";
import {
  type FlushOutcome,
  feedbackLockKey,
  flushPullRequestLocked,
  LOOSE_COMMENT_DELAY_MS,
  mergeIntoBatch,
} from "./dispatch";

/** 觸發 CI 修正的 check 結論。`cancelled`、`action_required`、`neutral`、`skipped`、`stale` 不觸發。 */
export const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out"]);

export type FeedbackIgnoreReason =
  | "feedback_disabled"
  | "unhandled_action"
  /** 不是以 App 開出、有對應 Task 的 PR。 */
  | "not_linked"
  | "pr_not_open"
  | "approved"
  | "empty"
  | "own_app"
  | "bot_not_allowlisted"
  | "no_write_permission"
  /** 不是 PR 目前 head 的 CI 結果。 */
  | "not_head"
  /** 還有 check suite 沒跑完。 */
  | "waiting_for_checks"
  | "no_new_failures";

export type FeedbackEventOutcome =
  | { kind: "ignored"; reason: FeedbackIgnoreReason }
  | {
      kind: "queued";
      source: FeedbackBatch["source"];
      prNumber: number;
      /** 批次中的回饋數。 */
      items: number;
      dueAt: string;
      flush: FlushOutcome;
    };

const ignored = (reason: FeedbackIgnoreReason) => ({ kind: "ignored", reason }) as const;

/** 留言者能不能觸發 Feedback Loop：有寫入權限的人類，或 Project 白名單中的 bot。App 自己一律不行。 */
async function authorAllowed(
  ctx: IntegrationContext,
  deps: FeedbackDependencies,
  task: TaskRecord,
  link: PullRequestLink,
  author: GitHubUserRef,
): Promise<FeedbackIgnoreReason | null> {
  if (isOwnEcho(ctx, author)) return "own_app";
  if (author.type === "Bot") {
    const allowlist = (await deps.botAllowlist(task.projectId)).map((l) => l.toLowerCase());
    return allowlist.includes(author.login.toLowerCase()) ? null : "bot_not_allowlisted";
  }
  return (await senderCanWrite(ctx, task.projectId, link.repoId, author.login, author.id))
    ? null
    : "no_write_permission";
}

type LinkedPullRequest =
  | { ok: true; link: PullRequestLink; task: TaskRecord }
  | { ok: false; reason: FeedbackIgnoreReason };

async function linkedOpenPullRequest(
  ctx: IntegrationContext,
  githubRepoId: number,
  prNumber: number,
): Promise<LinkedPullRequest> {
  const link = await ctx.store.findPullRequestLink(githubRepoId, prNumber);
  if (!link) return { ok: false, reason: "not_linked" };
  if (link.state !== "open") return { ok: false, reason: "pr_not_open" };
  const task = await ctx.domain.getTask(link.taskId);
  if (!task) return { ok: false, reason: "not_linked" };
  return { ok: true, link, task };
}

/** 放進批次（`immediate` 時立刻到期），並嘗試送出到期的批次。呼叫端要持有 PR 的鎖。 */
async function queueLocked(
  ctx: IntegrationContext,
  deps: FeedbackDependencies,
  batch: FeedbackBatch,
): Promise<FeedbackEventOutcome> {
  const merged = await mergeIntoBatch(deps, batch);
  const flush = await flushPullRequestLocked(ctx, deps, batch.githubRepoId, batch.prNumber);
  return {
    kind: "queued",
    source: merged.source,
    prNumber: merged.prNumber,
    items: merged.items.length,
    dueAt: merged.dueAt.toISOString(),
    flush,
  };
}

/** review 的回饋放進批次：完整的 review 立刻到期，零散的留言在 2 分鐘後到期。 */
async function queueReviewItems(
  ctx: IntegrationContext,
  deps: FeedbackDependencies,
  link: PullRequestLink,
  items: ReviewFeedbackItem[],
  immediate: boolean,
): Promise<FeedbackEventOutcome> {
  const now = ctx.now();
  return queueLocked(ctx, deps, {
    source: "review",
    githubRepoId: link.githubRepoId,
    prNumber: link.number,
    dueAt: immediate ? now : new Date(now.getTime() + LOOSE_COMMENT_DELAY_MS),
    items,
  });
}

/** `pull_request_review`：review 送出。 */
export async function handlePullRequestReviewEvent(
  ctx: IntegrationContext,
  payload: PullRequestReviewPayload,
): Promise<FeedbackEventOutcome> {
  const deps = ctx.feedback;
  if (!deps) return ignored("feedback_disabled");
  if (payload.action !== "submitted") return ignored("unhandled_action");
  const state = payload.review.state.toLowerCase();
  // 核准的 review 不觸發（就算附了留言），免得核准之後 Agent 又 push 新的 commit。
  if (state === "approved") return ignored("approved");
  if (state !== "commented" && state !== "changes_requested") return ignored("unhandled_action");

  const githubRepoId = payload.repository.id;
  const prNumber = payload.pull_request.number;
  return ctx.taskLocks.run(feedbackLockKey(githubRepoId, prNumber), async () => {
    const pr = await linkedOpenPullRequest(ctx, githubRepoId, prNumber);
    if (!pr.ok) return ignored(pr.reason);
    const author = payload.review.user;
    const rejected = await authorAllowed(ctx, deps, pr.task, pr.link, author);
    if (rejected) return ignored(rejected);

    const record = await ctx.domain.getRepo(pr.link.repoId);
    const repo = record && connectedRepo(record);
    if (!repo) return ignored("not_linked");
    const comments = await ctx.client.listReviewComments(
      repo.installationId,
      repo.ref,
      prNumber,
      payload.review.id,
    );

    const items: ReviewFeedbackItem[] = [];
    const body = payload.review.body?.trim() ?? "";
    if (body) {
      items.push({
        kind: "review",
        id: payload.review.id,
        reviewId: payload.review.id,
        author: author.login,
        body,
        url: payload.review.html_url,
        path: null,
        line: null,
        startLine: null,
        diffHunk: null,
      });
    }
    for (const comment of comments) {
      if (!comment.body.trim()) continue;
      items.push({
        kind: "review_comment",
        id: comment.id,
        reviewId: payload.review.id,
        author: comment.user.login,
        body: comment.body,
        url: comment.htmlUrl,
        path: comment.path,
        line: comment.line,
        startLine: comment.startLine,
        diffHunk: comment.diffHunk,
      });
    }
    if (items.length === 0) return ignored("empty");

    const isFullReview = body !== "" || state === "changes_requested" || comments.length >= 2;
    return queueReviewItems(ctx, deps, pr.link, items, isFullReview);
  });
}

/** `issue_comment.created` 在 PR 上：PR 對話串的留言，算零散留言。 */
export async function handlePullRequestCommentEvent(
  ctx: IntegrationContext,
  payload: IssueCommentPayload,
): Promise<FeedbackEventOutcome> {
  const deps = ctx.feedback;
  if (!deps) return ignored("feedback_disabled");
  if (payload.action !== "created") return ignored("unhandled_action");
  const githubRepoId = payload.repository.id;
  const prNumber = payload.issue.number;
  return ctx.taskLocks.run(feedbackLockKey(githubRepoId, prNumber), async () => {
    const pr = await linkedOpenPullRequest(ctx, githubRepoId, prNumber);
    if (!pr.ok) return ignored(pr.reason);
    const author = payload.comment.user ?? payload.sender;
    const rejected = await authorAllowed(ctx, deps, pr.task, pr.link, author);
    if (rejected) return ignored(rejected);
    const body = payload.comment.body?.trim() ?? "";
    if (!body) return ignored("empty");
    return queueReviewItems(
      ctx,
      deps,
      pr.link,
      [
        {
          kind: "pr_comment",
          id: payload.comment.id,
          reviewId: null,
          author: author.login,
          body,
          url: payload.comment.html_url ?? pr.link.url,
          path: null,
          line: null,
          startLine: null,
          diffHunk: null,
        },
      ],
      false,
    );
  });
}

/**
 * 判斷這個 commit 的 CI：PR 目前 head 的 check suite 都完成後，把還沒觸發過的失敗 check run
 * 合併成一批立刻送出。沒有 check run 的 suite（安裝了但沒在跑 check 的 App）不等。
 */
async function evaluateChecks(
  ctx: IntegrationContext,
  deps: FeedbackDependencies,
  githubRepoId: number,
  prNumbers: readonly number[],
  headSha: string,
): Promise<FeedbackEventOutcome[]> {
  const outcomes: FeedbackEventOutcome[] = [];
  for (const prNumber of new Set(prNumbers)) {
    outcomes.push(
      await ctx.taskLocks.run(feedbackLockKey(githubRepoId, prNumber), async () => {
        const pr = await linkedOpenPullRequest(ctx, githubRepoId, prNumber);
        if (!pr.ok) return ignored(pr.reason);
        if (pr.link.headSha !== headSha) return ignored("not_head");
        const record = await ctx.domain.getRepo(pr.link.repoId);
        const repo = record && connectedRepo(record);
        if (!repo) return ignored("not_linked");

        const suites = await ctx.client.listCheckSuites(repo.installationId, repo.ref, headSha);
        if (suites.some((s) => s.latestCheckRunsCount > 0 && s.status !== "completed")) {
          return ignored("waiting_for_checks");
        }
        const runs = await ctx.client.listCheckRuns(repo.installationId, repo.ref, headSha);
        const failing = runs.filter(
          (r) => r.status === "completed" && r.conclusion && FAILING_CONCLUSIONS.has(r.conclusion),
        );

        // 已經觸發過（送出、達到上限或待送中）的 check run 不再觸發。
        const handled = new Set<number>();
        for (const fix of await deps.store.listFeedbackFixes(githubRepoId, prNumber)) {
          if (fix.trigger.source === "ci" && fix.trigger.headSha === headSha) {
            for (const item of fix.trigger.items) handled.add(item.checkRunId);
          }
        }
        const pending = await deps.store.getFeedbackBatch(githubRepoId, prNumber, "ci");
        if (pending?.source === "ci" && pending.headSha === headSha) {
          for (const item of pending.items) handled.add(item.checkRunId);
        }
        const items: CiFeedbackItem[] = failing
          .filter((r) => !handled.has(r.id))
          .map((r) => ({
            checkRunId: r.id,
            name: r.name,
            conclusion: r.conclusion ?? "failure",
            appSlug: r.appSlug,
            url: r.htmlUrl,
            outputTitle: r.outputTitle,
            outputSummary: r.outputSummary,
          }));
        if (items.length === 0) return ignored("no_new_failures");

        return queueLocked(ctx, deps, {
          source: "ci",
          githubRepoId,
          prNumber,
          headSha,
          dueAt: ctx.now(),
          items,
        });
      }),
    );
  }
  return outcomes;
}

/** `check_suite.completed`。 */
export async function handleCheckSuiteEvent(
  ctx: IntegrationContext,
  payload: CheckSuitePayload,
): Promise<FeedbackEventOutcome[] | FeedbackEventOutcome> {
  const deps = ctx.feedback;
  if (!deps) return ignored("feedback_disabled");
  if (payload.action !== "completed") return ignored("unhandled_action");
  return evaluateChecks(
    ctx,
    deps,
    payload.repository.id,
    payload.check_suite.pull_requests.map((p) => p.number),
    payload.check_suite.head_sha,
  );
}

/**
 * `check_run.completed`：只看失敗的 check run（成功的不會帶來新的失敗；suite 完成時會再判斷一次）。
 * check run 與 check suite 都是觸發來源，判斷是冪等的，哪個事件先到結果都一樣。
 */
export async function handleCheckRunEvent(
  ctx: IntegrationContext,
  payload: CheckRunPayload,
): Promise<FeedbackEventOutcome[] | FeedbackEventOutcome> {
  const deps = ctx.feedback;
  if (!deps) return ignored("feedback_disabled");
  if (payload.action !== "completed") return ignored("unhandled_action");
  const conclusion = payload.check_run.conclusion;
  if (!conclusion || !FAILING_CONCLUSIONS.has(conclusion)) return ignored("no_new_failures");
  return evaluateChecks(
    ctx,
    deps,
    payload.repository.id,
    payload.check_run.pull_requests.map((p) => p.number),
    payload.check_run.head_sha,
  );
}
