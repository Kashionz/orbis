// Feedback Loop 的紀錄（ARCHITECTURE §5.2）：每次自動修正都在 PR 上留言、在 Task 上留下 Task note，
// 註明是哪則留言或哪個 check 觸發；修正 push 之後在同一則 PR 留言補上新的 commit。
// 達到次數上限時停下，在 PR 上說明並通知 Task 負責人。

import { NAMES } from "@orbis/api-contract";
import { GitHubApiError } from "../client/types";
import { connectedRepo, type IntegrationContext, taskOwner } from "../context";
import type {
  FeedbackDependencies,
  FeedbackFix,
  FeedbackSource,
  PullRequestLink,
  TaskRecord,
} from "../ports";

/** 每個 PR 每種來源最多自動修正幾次（ARCHITECTURE §5.2）。 */
export const FEEDBACK_FIX_LIMIT = 5;

/** PR 上自動修正紀錄留言的隱藏標記。 */
export const FEEDBACK_FIX_MARKER = `<!-- ${NAMES.productSlug}:feedback-fix -->`;

const SOURCE_LABELS: Record<FeedbackSource, string> = { review: "review", ci: "CI" };

/** 計入次數的修正：已經開成 Run 的（之後 Run 失敗也算，避免一直重試）。 */
export function countsTowardLimit(fix: FeedbackFix): boolean {
  return fix.runId !== null;
}

/** 這筆修正是這個來源的第幾次（只算計入次數的）。 */
export function fixNumber(fix: FeedbackFix, all: readonly FeedbackFix[]): number {
  const counted = all.filter((f) => f.source === fix.source && countsTowardLimit(f));
  const index = counted.findIndex((f) => f.id === fix.id);
  return index < 0 ? counted.length : index + 1;
}

function commitUrl(link: PullRequestLink, sha: string): string {
  return `${link.url.replace(/\/pull\/\d+$/, "")}/commit/${sha}`;
}

/** 觸發這次修正的回饋，一行一個。 */
function triggerLines(fix: FeedbackFix): string[] {
  const trigger = fix.trigger;
  if (trigger.source === "ci") {
    return trigger.items.map((i) => `- check [\`${i.name}\`](${i.url})（${i.conclusion}）`);
  }
  return trigger.items.map((i) => {
    if (i.kind === "review") return `- @${i.author} 的 [review](${i.url})`;
    if (i.kind === "pr_comment") return `- @${i.author} 的 [留言](${i.url})`;
    const where = i.path ? `\`${i.path}\`${i.line === null ? "" : ` 第 ${i.line} 行`}` : "行內留言";
    return `- @${i.author} 在 ${where} 的 [留言](${i.url})`;
  });
}

function triggerSummary(fix: FeedbackFix): string {
  const trigger = fix.trigger;
  if (trigger.source === "ci") {
    return `commit \`${trigger.headSha.slice(0, 7)}\` 的 ${trigger.items.length} 個失敗的 check`;
  }
  const authors = [...new Set(trigger.items.map((i) => `@${i.author}`))].join("、");
  return `${authors} 的 ${trigger.items.length} 則 review 回饋`;
}

/** PR 上的紀錄留言（依目前的狀態重新產生，push 後以同樣的函式更新）。 */
export function renderFixComment(
  fix: FeedbackFix,
  all: readonly FeedbackFix[],
  link: PullRequestLink,
): string {
  const source = SOURCE_LABELS[fix.source];
  const lines = [FEEDBACK_FIX_MARKER];
  if (fix.status === "limit_reached") {
    lines.push(
      `### ${NAMES.productName}：自動修正已達上限（${source} ${FEEDBACK_FIX_LIMIT}／${FEEDBACK_FIX_LIMIT} 次）`,
      "",
      `這個 PR 的 ${source} 回饋已經自動修正 ${FEEDBACK_FIX_LIMIT} 次，之後不再自動送回 Agent，請手動處理。已通知 Task 負責人。`,
      "",
      "這次沒有送出的回饋：",
      ...triggerLines(fix),
    );
    return lines.join("\n");
  }
  if (fix.runId === null) {
    lines.push(
      `### ${NAMES.productName}：自動修正沒有送出（${source}）`,
      "",
      `原因：${fix.message ?? "未知"}`,
      "",
      "觸發的回饋：",
      ...triggerLines(fix),
    );
    return lines.join("\n");
  }
  const number = fixNumber(fix, all);
  lines.push(
    `### ${NAMES.productName}：自動修正（${source} 第 ${number}／${FEEDBACK_FIX_LIMIT} 次）`,
    "",
    "觸發的回饋：",
    ...triggerLines(fix),
    "",
  );
  if (fix.status === "pushed" && fix.commitSha) {
    lines.push(
      `✅ 修正已 push：[\`${fix.commitSha.slice(0, 7)}\`](${commitUrl(link, fix.commitSha)})`,
    );
  } else if (fix.status === "failed") {
    lines.push(`⚠️ 修正的 Run 沒有 push 就結束：${fix.message ?? ""}`.trimEnd());
  } else {
    lines.push("⏳ Agent 修正中，push 之後會在這裡附上新的 commit。");
  }
  return lines.join("\n");
}

function taskNoteBody(fix: FeedbackFix, all: readonly FeedbackFix[]): string {
  const source = SOURCE_LABELS[fix.source];
  if (fix.status === "limit_reached") {
    return `Feedback Loop：${source} 的自動修正已達上限（${FEEDBACK_FIX_LIMIT} 次），這次的回饋沒有送出，需要手動處理。觸發來源：${triggerSummary(fix)}。`;
  }
  if (fix.runId === null) {
    return `Feedback Loop：自動修正沒有送出（${fix.message ?? "未知原因"}）。觸發來源：${triggerSummary(fix)}。`;
  }
  return `Feedback Loop：自動修正（${source} 第 ${fixNumber(fix, all)}／${FEEDBACK_FIX_LIMIT} 次）。觸發來源：${triggerSummary(fix)}。`;
}

/**
 * 新的一筆修正紀錄：在 PR 上留言、在 Task 上留下 Task note，達到上限時通知負責人。
 * 留言失敗（GitHub 回錯）不影響修正本身，只記 log。回傳更新後的紀錄（含留言 id）。
 */
export async function recordFix(
  ctx: IntegrationContext,
  deps: FeedbackDependencies,
  link: PullRequestLink,
  task: TaskRecord | null,
  fix: FeedbackFix,
  all: readonly FeedbackFix[],
): Promise<FeedbackFix> {
  const record = await ctx.domain.getRepo(link.repoId);
  const repo = record && connectedRepo(record);
  let commentUrl: string | null = null;
  if (repo) {
    try {
      const comment = await ctx.client.createIssueComment(
        repo.installationId,
        repo.ref,
        link.number,
        renderFixComment(fix, all, link),
      );
      fix.prCommentId = comment.id;
      commentUrl = `${link.url}#issuecomment-${comment.id}`;
      await deps.store.saveFeedbackFix(fix);
    } catch (error) {
      if (!(error instanceof GitHubApiError)) throw error;
      ctx.logger.error({ err: error, pullRequest: link.url }, "在 PR 上留下自動修正的紀錄失敗");
    }
  }
  await deps.addTaskNote({
    taskId: fix.taskId,
    runId: fix.runId,
    body: taskNoteBody(fix, all),
    url: commentUrl ?? link.url,
  });

  const owner = task && taskOwner(task);
  if (fix.status === "limit_reached" && task && owner) {
    await ctx.notifier.notify({
      memberId: owner,
      kind: "feedback_limit_reached",
      taskId: task.id,
      message: `${task.key} 的 PR 的 ${SOURCE_LABELS[fix.source]} 自動修正已達上限（${FEEDBACK_FIX_LIMIT} 次），需要手動處理`,
      url: commentUrl ?? link.url,
    });
  }
  return fix;
}

/** 修正的狀態改變（push 了或 Run 沒有 push 就結束）：更新 PR 上同一則紀錄留言。 */
export async function updateFixComment(
  ctx: IntegrationContext,
  fix: FeedbackFix,
  all: readonly FeedbackFix[],
): Promise<void> {
  if (fix.prCommentId === null) return;
  const link = await ctx.store.findPullRequestLink(fix.githubRepoId, fix.prNumber);
  if (!link) return;
  const record = await ctx.domain.getRepo(link.repoId);
  const repo = record && connectedRepo(record);
  if (!repo) return;
  try {
    await ctx.client.updateIssueComment(
      repo.installationId,
      repo.ref,
      fix.prCommentId,
      renderFixComment(fix, all, link),
    );
  } catch (error) {
    if (!(error instanceof GitHubApiError)) throw error;
    ctx.logger.error({ err: error, pullRequest: link.url }, "更新 PR 上自動修正的紀錄失敗");
  }
}
