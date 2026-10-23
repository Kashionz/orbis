// Feedback Loop 的批次與送出（ARCHITECTURE §5.2）：回饋先放進每個 PR 的待送批次，到期後送回 Agent。
// 同一個 PR 同時只有一次自動修正；修正還沒 push 時，新的回饋留在批次中，修正完成後再送。

import { randomUUID } from "node:crypto";
import type { IntegrationContext } from "../context";
import type {
  FeedbackBatch,
  FeedbackDependencies,
  FeedbackFix,
  FeedbackSource,
  PullRequestLink,
} from "../ports";
import { collectCiDetails } from "./ci-details";
import { renderFeedbackPrompt } from "./prompt";

/** 零散的留言在最後一則之後等這麼久才送出（同一段時間內的留言合併成一批）。 */
export const LOOSE_COMMENT_DELAY_MS = 2 * 60 * 1000;

/** 每個 PR 的批次與送出以這個 key 序列化。 */
export function feedbackLockKey(githubRepoId: number, prNumber: number): string {
  return `feedback:${githubRepoId}#${prNumber}`;
}

/** 同一個 PR 有兩種來源都到期時，先送 review（人的意見），CI 等修正 push 後依新的 commit 重新判斷。 */
const SOURCE_ORDER: readonly FeedbackSource[] = ["review", "ci"];

export type FlushOutcome =
  | { kind: "nothing" }
  /** 前一次自動修正還沒完成，批次留著。 */
  | { kind: "held"; fixId: string }
  | { kind: "sent"; source: FeedbackSource; fixId: string; runId: string }
  | { kind: "failed"; source: FeedbackSource; fixId: string; message: string };

/** 把回饋併進批次（同一則回饋只留一份），存回 store。 */
export async function mergeIntoBatch(
  deps: FeedbackDependencies,
  batch: FeedbackBatch,
): Promise<FeedbackBatch> {
  const existing = await deps.store.getFeedbackBatch(
    batch.githubRepoId,
    batch.prNumber,
    batch.source,
  );
  let merged: FeedbackBatch = batch;
  if (existing?.source === "review" && batch.source === "review") {
    const seen = new Set(batch.items.map((i) => `${i.kind}:${i.id}`));
    merged = {
      ...batch,
      items: [...existing.items.filter((i) => !seen.has(`${i.kind}:${i.id}`)), ...batch.items],
    };
  } else if (
    existing?.source === "ci" &&
    batch.source === "ci" &&
    existing.headSha === batch.headSha
  ) {
    const seen = new Set(batch.items.map((i) => i.checkRunId));
    merged = {
      ...batch,
      items: [...existing.items.filter((i) => !seen.has(i.checkRunId)), ...batch.items],
    };
  }
  await deps.store.saveFeedbackBatch(merged);
  return merged;
}

/**
 * 送出這個 PR 到期的批次（呼叫端要持有 `feedbackLockKey` 的鎖）。PR 已經不是 open 時丟掉批次。
 */
export async function flushPullRequestLocked(
  ctx: IntegrationContext,
  deps: FeedbackDependencies,
  githubRepoId: number,
  prNumber: number,
): Promise<FlushOutcome> {
  const link = await ctx.store.findPullRequestLink(githubRepoId, prNumber);
  if (link?.state !== "open") {
    for (const source of SOURCE_ORDER) {
      await deps.store.deleteFeedbackBatch(githubRepoId, prNumber, source);
    }
    return { kind: "nothing" };
  }
  const fixes = await deps.store.listFeedbackFixes(githubRepoId, prNumber);
  const active = fixes.find((f) => f.status === "sent");
  if (active) return { kind: "held", fixId: active.id };

  const now = ctx.now();
  for (const source of SOURCE_ORDER) {
    const batch = await deps.store.getFeedbackBatch(githubRepoId, prNumber, source);
    if (!batch || batch.dueAt.getTime() > now.getTime()) continue;
    if (batch.source === "ci" && batch.headSha !== link.headSha) {
      // PR 已經有新的 commit，舊 commit 的 CI 結果不再適用。
      await deps.store.deleteFeedbackBatch(githubRepoId, prNumber, source);
      continue;
    }
    return dispatchBatch(ctx, deps, link, batch);
  }
  return { kind: "nothing" };
}

/** 請 Server 開新的 Run 修正這批回饋，並留下紀錄。 */
async function dispatchBatch(
  ctx: IntegrationContext,
  deps: FeedbackDependencies,
  link: PullRequestLink,
  batch: FeedbackBatch,
): Promise<FlushOutcome> {
  await deps.store.deleteFeedbackBatch(batch.githubRepoId, batch.prNumber, batch.source);
  const now = ctx.now();
  const fix: FeedbackFix = {
    id: randomUUID(),
    taskId: link.taskId,
    githubRepoId: link.githubRepoId,
    prNumber: link.number,
    source: batch.source,
    previousRunId: link.runId,
    runId: null,
    trigger: batch,
    status: "failed",
    commitSha: null,
    message: null,
    createdAt: now,
    updatedAt: now,
  };

  if (!link.runId) {
    fix.message = "開出這個 PR 的 Run 已經不存在，無法接續";
  } else {
    const result = await deps.runs.requestFix({
      taskId: link.taskId,
      previousRunId: link.runId,
      source: batch.source,
      prompt: renderFeedbackPrompt(batch, {
        pullRequestUrl: link.url,
        ...(batch.source === "ci" && {
          ciDetails: await collectCiDetails(ctx, link, batch.items),
        }),
      }),
      pullRequestUrl: link.url,
    });
    if (result.ok) {
      fix.status = "sent";
      fix.runId = result.runId;
    } else {
      fix.message = result.message;
    }
  }
  await deps.store.saveFeedbackFix(fix);

  if (fix.status === "sent" && fix.runId) {
    ctx.logger.info(
      { taskId: link.taskId, pullRequest: link.url, source: batch.source, runId: fix.runId },
      "已送出 Feedback Loop 的自動修正",
    );
    return { kind: "sent", source: batch.source, fixId: fix.id, runId: fix.runId };
  }
  ctx.logger.warn(
    { taskId: link.taskId, pullRequest: link.url, source: batch.source, message: fix.message },
    "Feedback Loop 的自動修正沒有送出",
  );
  return { kind: "failed", source: batch.source, fixId: fix.id, message: fix.message ?? "" };
}

export async function flushPullRequest(
  ctx: IntegrationContext,
  deps: FeedbackDependencies,
  githubRepoId: number,
  prNumber: number,
): Promise<FlushOutcome> {
  return ctx.taskLocks.run(feedbackLockKey(githubRepoId, prNumber), () =>
    flushPullRequestLocked(ctx, deps, githubRepoId, prNumber),
  );
}

/** 送出所有到期的批次（Server 定時呼叫，或由 `startFeedbackTimer` 定時執行）。 */
export async function flushDueFeedback(ctx: IntegrationContext): Promise<FlushOutcome[]> {
  const deps = ctx.feedback;
  if (!deps) return [];
  const due = await deps.store.listDueFeedbackBatches(ctx.now());
  const prs = new Map(due.map((b) => [`${b.githubRepoId}#${b.prNumber}`, b]));
  const outcomes: FlushOutcome[] = [];
  for (const batch of prs.values()) {
    outcomes.push(await flushPullRequest(ctx, deps, batch.githubRepoId, batch.prNumber));
  }
  return outcomes;
}

/**
 * 自動修正的 Run 結束：push 了（帶 `commitSha`）或沒有 push 就結束。更新紀錄，並送出這段期間累積的回饋。
 * 不是 Feedback Loop 的 Run 時什麼都不做，回傳 null。
 */
export async function finishFeedbackFix(
  ctx: IntegrationContext,
  runId: string,
  result: { pushed: true; commitSha: string } | { pushed: false },
): Promise<{ fix: FeedbackFix; flush: FlushOutcome } | null> {
  const deps = ctx.feedback;
  if (!deps) return null;
  const found = await deps.store.findFeedbackFixByRun(runId);
  if (!found) return null;
  return ctx.taskLocks.run(feedbackLockKey(found.githubRepoId, found.prNumber), async () => {
    const fix = (await deps.store.findFeedbackFixByRun(runId)) ?? found;
    if (fix.status === "sent") {
      if (result.pushed) {
        fix.status = "pushed";
        fix.commitSha = result.commitSha;
      } else {
        fix.status = "failed";
        fix.message = "修正的 Run 沒有 push 就結束";
      }
      fix.updatedAt = ctx.now();
      await deps.store.saveFeedbackFix(fix);
    }
    const flush = await flushPullRequestLocked(ctx, deps, fix.githubRepoId, fix.prNumber);
    return { fix, flush };
  });
}
