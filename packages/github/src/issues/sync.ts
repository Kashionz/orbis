// Task 與 GitHub Issue 的雙向同步（ARCHITECTURE §11、ADR-0004）。
//
// - Orbis→GitHub：比較 Task 與上次同步的快照，只寫出 Task 這邊改過的欄位。
// - GitHub→Orbis：比較 webhook 的 Issue 與快照，只套用 GitHub 這邊改過、而且比快照新的欄位。
//   兩邊同一欄位都改過時，以最後寫入者為準（Issue 的 updated_at 對上 Task 的 updatedAt）。
// - 回音：App 自己的寫入造成的 webhook 以 sender 辨認並略過；就算沒有略過，
//   payload 與快照相同（或不比快照新）也不會寫入。

import { createHash } from "node:crypto";
import { toIssue } from "../client/http";
import {
  type GitHubIssue,
  type GitHubUserRef,
  type IssuePatch,
  WRITE_ROLES,
} from "../client/types";
import { type ConnectedRepo, connectedRepo, type IntegrationContext, isOwnEcho } from "../context";
import { renderSummaryComment } from "../markdown";
import type { IssueLink, MemberRecord, SyncedField, TaskFieldsPatch, TaskRecord } from "../ports";
import type { IssuesPayload } from "../webhook/payloads";
import {
  differentFields,
  fieldsFromIssue,
  fieldsFromTask,
  freshSnapshot,
  type IssueFields,
  isAfter,
  SYNCED_FIELDS,
  sameValue,
  snapshotFields,
  updateSnapshot,
} from "./fields";

export type PushOutcome =
  | { kind: "skipped"; reason: "task_not_found" | "no_repo" | "repo_not_connected" }
  | { kind: "synced"; issueNumber: number; created: boolean; wrote: SyncedField[] };

export interface PushOptions {
  /** 顯示在狀態摘要留言上的提醒。 */
  notice?: string;
}

/** Orbis→GitHub：把 Task 同步到對應的 Issue（沒有就建立），並更新狀態摘要留言。 */
export function pushTask(
  ctx: IntegrationContext,
  taskId: string,
  options: PushOptions = {},
): Promise<PushOutcome> {
  return ctx.taskLocks.run(taskId, () => pushTaskLocked(ctx, taskId, options));
}

async function pushTaskLocked(
  ctx: IntegrationContext,
  taskId: string,
  options: PushOptions,
): Promise<PushOutcome> {
  const task = await ctx.domain.getTask(taskId);
  if (!task) return { kind: "skipped", reason: "task_not_found" };
  if (!task.repoId) return { kind: "skipped", reason: "no_repo" };
  const record = await ctx.domain.getRepo(task.repoId);
  const repo = record && connectedRepo(record);
  if (!repo) return { kind: "skipped", reason: "repo_not_connected" };

  const assignee = task.assigneeMemberId ? await ctx.domain.getMember(task.assigneeMemberId) : null;
  const desired = fieldsFromTask(task, assignee?.githubUserId ?? null);

  let link = await ctx.store.getIssueLinkByTask(task.id);
  if (link && link.githubRepoId !== repo.githubRepoId) {
    // Task 的 Repo 不能更換（ADR-0011），照理不會發生；萬一發生，不要寫到另一個 repo 的 Issue。
    ctx.logger.warn(
      { taskId: task.id, issue: link.issueUrl },
      "Issue 對應的 repo 與 Task 的 Repo 不同，重新建立",
    );
    await ctx.store.deleteIssueLink(task.id);
    link = null;
  }
  let created = false;
  let wrote: SyncedField[] = [];

  if (!link) {
    let issue = await ctx.client.createIssue(repo.installationId, repo.ref, {
      title: desired.title,
      body: desired.body,
      assignees: assignee ? [assignee.githubLogin] : [],
      labels: desired.labels,
    });
    if (desired.state === "closed") {
      issue = await ctx.client.updateIssue(repo.installationId, repo.ref, issue.number, {
        state: "closed",
        stateReason: "completed",
      });
    }
    link = {
      taskId: task.id,
      repoId: repo.record.id,
      githubRepoId: repo.githubRepoId,
      issueNumber: issue.number,
      issueId: issue.id,
      issueUrl: issue.htmlUrl,
      summaryCommentId: null,
      summaryHash: null,
      snapshot: freshSnapshot(writtenFields(desired, issue), issue.updatedAt),
    };
    created = true;
    wrote = [...SYNCED_FIELDS];
    ctx.logger.info({ taskId: task.id, issue: issue.htmlUrl }, "已為 Task 建立 GitHub Issue");
  } else {
    const changed = differentFields(desired, snapshotFields(link.snapshot));
    if (changed.length > 0) {
      const issue = await ctx.client.updateIssue(
        repo.installationId,
        repo.ref,
        link.issueNumber,
        issuePatch(desired, changed, assignee),
      );
      link = {
        ...link,
        snapshot: updateSnapshot(
          link.snapshot,
          writtenFields(desired, issue),
          changed,
          issue.updatedAt,
        ),
      };
      wrote = changed;
    }
  }

  link = await upsertSummaryComment(ctx, task, repo, link, options.notice);
  await ctx.store.saveIssueLink(link);
  return { kind: "synced", issueNumber: link.issueNumber, created, wrote };
}

/**
 * 寫出之後 Issue 實際的欄位。GitHub 會默默略過不能被指派的 assignee（例如沒有 repo 權限），
 * 所以 assignee 以回應為準；這樣之後 GitHub 端的其他修改不會被誤判成「assignee 被清掉」。
 */
function writtenFields(desired: IssueFields, issue: GitHubIssue): IssueFields {
  const assigned = issue.assignees.some((a) => a.id === desired.assignee);
  return fieldsFromIssue(issue, assigned ? desired.assignee : null);
}

function issuePatch(
  desired: IssueFields,
  changed: readonly SyncedField[],
  assignee: MemberRecord | null,
): IssuePatch {
  const patch: IssuePatch = {};
  for (const field of changed) {
    switch (field) {
      case "title":
        patch.title = desired.title;
        break;
      case "body":
        patch.body = desired.body;
        break;
      case "state":
        patch.state = desired.state;
        patch.stateReason = desired.state === "closed" ? "completed" : "reopened";
        break;
      case "assignee":
        patch.assignees = assignee ? [assignee.githubLogin] : [];
        break;
      case "labels":
        patch.labels = desired.labels;
        break;
    }
  }
  return patch;
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 建立或更新 Issue 上唯一的一則狀態摘要留言；內容沒變就不呼叫 API，被刪除了就重建。 */
async function upsertSummaryComment(
  ctx: IntegrationContext,
  task: TaskRecord,
  repo: ConnectedRepo,
  link: IssueLink,
  notice: string | undefined,
): Promise<IssueLink> {
  const [criteria, latestRun] = await Promise.all([
    ctx.domain.listAcceptanceCriteria(task.id),
    ctx.domain.getLatestRun(task.id),
  ]);
  const body = renderSummaryComment({
    task,
    taskUrl: ctx.taskUrl(task),
    criteria,
    latestRun,
    ...(notice ? { notice } : {}),
  });
  const hash = hashOf(body);
  if (link.summaryCommentId !== null) {
    if (link.summaryHash === hash) return link;
    const updated = await ctx.client.updateIssueComment(
      repo.installationId,
      repo.ref,
      link.summaryCommentId,
      body,
    );
    if (updated) return { ...link, summaryHash: hash };
  }
  const comment = await ctx.client.createIssueComment(
    repo.installationId,
    repo.ref,
    link.issueNumber,
    body,
  );
  return { ...link, summaryCommentId: comment.id, summaryHash: hash };
}

/**
 * 送出 webhook 的人能不能改動 Task：在 Project 中能編輯 Task 的 Member，
 * 或對 repo 有寫入權限（admin、maintain、write）的人。
 */
async function senderCanWrite(
  ctx: IntegrationContext,
  projectId: string,
  repoId: string,
  login: string,
  githubUserId: number,
): Promise<boolean> {
  const member = await ctx.domain.findMemberByGithubUserId(projectId, githubUserId);
  if (member && (await ctx.domain.canEditTasks(projectId, member.id))) return true;
  const record = await ctx.domain.getRepo(repoId);
  const repo = record && connectedRepo(record);
  if (!repo) return false;
  const role = await ctx.client.getCollaboratorRole(repo.installationId, repo.ref, {
    login,
    id: githubUserId,
  });
  return WRITE_ROLES.has(role);
}

/** 這個 action 改到的同步欄位。`edited` 依 payload 的 `changes`。 */
function fieldsTouchedBy(payload: IssuesPayload): SyncedField[] {
  switch (payload.action) {
    case "edited":
      return (["title", "body"] as const).filter(
        (field) => payload.changes && field in payload.changes,
      );
    case "assigned":
    case "unassigned":
      return ["assignee"];
    case "labeled":
    case "unlabeled":
      return ["labels"];
    case "closed":
    case "reopened":
      return ["state"];
    default:
      return [];
  }
}

/** Issue 的 assignees 中第一個屬於 Team 的 Member。 */
export async function mapAssignee(
  ctx: IntegrationContext,
  projectId: string,
  assignees: readonly GitHubUserRef[],
): Promise<MemberRecord | null> {
  for (const user of assignees) {
    const member = await ctx.domain.findMemberByGithubUserId(projectId, user.id);
    if (member) return member;
  }
  return null;
}

export type IssueEventOutcome =
  | { kind: "echo" }
  | { kind: "ignored"; reason: "unhandled_action" | "not_linked" }
  | { kind: "unlinked"; taskId: string }
  | { kind: "no_change"; taskId: string }
  /** 送出修改的人沒有 repo 的寫入權限，修改不寫回 Task，並把 Issue 改回 Task 的值。 */
  | { kind: "rejected"; taskId: string; fields: SyncedField[]; reason: "sender_not_authorized" }
  | {
      kind: "applied";
      taskId: string;
      /** 套用到 Task 的欄位。 */
      applied: SyncedField[];
      /** 衝突時 Task 比較新、改寫回 GitHub 的欄位。 */
      overridden: SyncedField[];
      notice: string | null;
    };

const ISSUE_ACTIONS = new Set([
  "edited",
  "closed",
  "reopened",
  "assigned",
  "unassigned",
  "labeled",
  "unlabeled",
  "deleted",
  "transferred",
]);

/** GitHub→Orbis：處理 `issues` webhook。 */
export async function handleIssuesEvent(
  ctx: IntegrationContext,
  payload: IssuesPayload,
): Promise<IssueEventOutcome[]> {
  if (!ISSUE_ACTIONS.has(payload.action)) return [{ kind: "ignored", reason: "unhandled_action" }];
  if (isOwnEcho(ctx, payload.sender)) return [{ kind: "echo" }];

  const links = await ctx.store.findIssueLinks(payload.repository.id, payload.issue.number);
  if (links.length === 0) return [{ kind: "ignored", reason: "not_linked" }];

  const outcomes: IssueEventOutcome[] = [];
  for (const { taskId } of links) {
    outcomes.push(await ctx.taskLocks.run(taskId, () => applyIssueChange(ctx, taskId, payload)));
  }
  return outcomes;
}

async function applyIssueChange(
  ctx: IntegrationContext,
  taskId: string,
  payload: IssuesPayload,
): Promise<IssueEventOutcome> {
  const link = await ctx.store.getIssueLinkByTask(taskId);
  if (
    !link ||
    link.githubRepoId !== payload.repository.id ||
    link.issueNumber !== payload.issue.number
  ) {
    return { kind: "ignored", reason: "not_linked" };
  }

  if (payload.action === "deleted" || payload.action === "transferred") {
    await ctx.store.deleteIssueLink(taskId);
    ctx.logger.warn(
      { taskId, issue: link.issueUrl, action: payload.action },
      "對應的 GitHub Issue 已被刪除或移走，解除對應",
    );
    return { kind: "unlinked", taskId };
  }

  const task = await ctx.domain.getTask(taskId);
  if (!task) return { kind: "ignored", reason: "not_linked" };

  const issue = toIssue(payload.issue);
  const mapped = await mapAssignee(ctx, task.projectId, issue.assignees);
  const incoming = fieldsFromIssue(issue, mapped?.githubUserId ?? null);
  const { snapshot } = link;

  // GitHub 這邊真的改過的欄位：與快照不同，而且比該欄位上次同步的時間新。
  // 不比快照新的是過期的 payload（例如 App 自己的寫入之前發生的修改），不套用。
  // 只看這個 action 改到的欄位：其他與快照不同的欄位不能算在這位 sender 頭上（例如之前沒寫入權限的人的修改、
  // 或 webhook 晚到），不套用也不更新快照，等它們自己的 webhook。
  const touched = fieldsTouchedBy(payload);
  const changed = differentFields(incoming, snapshotFields(snapshot)).filter(
    (field) => touched.includes(field) && isAfter(issue.updatedAt, snapshot.syncedAt[field]),
  );
  if (changed.length === 0) return { kind: "no_change", taskId };

  const nextSnapshot = updateSnapshot(snapshot, incoming, changed, issue.updatedAt);
  if (
    !(await senderCanWrite(
      ctx,
      task.projectId,
      link.repoId,
      payload.sender.login,
      payload.sender.id,
    ))
  ) {
    // 例如公開 repo 上 Issue 的作者可以改自己 Issue 的內容、關閉自己的 Issue，但不應該因此改動 Task。
    await ctx.store.saveIssueLink({ ...link, snapshot: nextSnapshot });
    const notice = `@${payload.sender.login} 沒有這個 repo 的寫入權限，對 Issue 的修改已還原。`;
    await pushTaskLocked(ctx, taskId, { notice });
    ctx.logger.warn(
      { taskId, issue: link.issueUrl, sender: payload.sender.login, fields: changed },
      "沒有寫入權限的人修改了 Issue，已還原",
    );
    return { kind: "rejected", taskId, fields: changed, reason: "sender_not_authorized" };
  }

  const assignee = task.assigneeMemberId ? await ctx.domain.getMember(task.assigneeMemberId) : null;
  const current = fieldsFromTask(task, assignee?.githubUserId ?? null);
  // Task 這邊沒改過，或 Issue 的修改比較新 → GitHub 勝出；否則 Task 勝出，稍後寫回 GitHub。
  const applied = changed.filter(
    (field) =>
      sameValue(current[field], snapshot[field]) || isAfter(issue.updatedAt, task.updatedAt),
  );
  const overridden = changed.filter((field) => !applied.includes(field));

  const patch: TaskFieldsPatch = {};
  for (const field of applied) {
    if (field === "title") patch.title = incoming.title;
    if (field === "body") patch.description = incoming.body;
    if (field === "labels") patch.labels = incoming.labels;
    if (field === "assignee") patch.assigneeMemberId = mapped?.id ?? null;
  }
  if (Object.keys(patch).length > 0) await ctx.domain.updateTaskFields(taskId, patch);

  let notice: string | null = null;
  if (applied.includes("state")) {
    notice = await applyIssueState(ctx, task, incoming.state, link.issueUrl, payload.sender.login);
  }

  // 快照記錄 GitHub 目前的實際狀態；被拒絕的狀態轉換、Task 勝出的欄位，會在下面的 push 中寫回。
  await ctx.store.saveIssueLink({ ...link, snapshot: nextSnapshot });
  await pushTaskLocked(ctx, taskId, notice ? { notice } : {});

  ctx.logger.info(
    { taskId, issue: link.issueUrl, applied, overridden, notice },
    "已從 GitHub Issue 同步到 Task",
  );
  return { kind: "applied", taskId, applied, overridden, notice };
}

/**
 * Issue 被關閉 → Task 轉 Done；Issue 被重新打開 → Done 的 Task 回到 Backlog。
 * 狀態機拒絕時回傳要顯示在摘要留言上的說明（Issue 的 state 會在之後的 push 改回來）。
 */
async function applyIssueState(
  ctx: IntegrationContext,
  task: TaskRecord,
  state: "open" | "closed",
  issueUrl: string,
  byGithubLogin: string,
): Promise<string | null> {
  if (state === "closed" && task.status !== "done") {
    const result = await ctx.domain.transitionTask(task.id, "done", {
      kind: "issue_closed",
      issueUrl,
      byGithubLogin,
    });
    if (result.ok) return null;
    return result.reason === "active_run"
      ? `@${byGithubLogin} 關閉了這個 Issue，但 Task 還有進行中的 Run，所以重新打開。請先在 Task 頁中止 Run。`
      : `@${byGithubLogin} 關閉了這個 Issue，但 Task 目前的狀態不能轉成 Done，所以重新打開。`;
  }
  if (state === "open" && task.status === "done") {
    const result = await ctx.domain.transitionTask(task.id, "backlog", {
      kind: "issue_reopened",
      issueUrl,
      byGithubLogin,
    });
    if (result.ok) return null;
    return `@${byGithubLogin} 重新打開了這個 Issue，但 Task 不能回到 Backlog，所以再次關閉。`;
  }
  return null;
}

/** 某則留言被刪除：如果是狀態摘要留言，忘掉它並重建。 */
export async function handleSummaryCommentDeleted(
  ctx: IntegrationContext,
  githubRepoId: number,
  issueNumber: number,
  commentId: number,
): Promise<string[]> {
  const links = await ctx.store.findIssueLinks(githubRepoId, issueNumber);
  const recreated: string[] = [];
  for (const { taskId } of links) {
    await ctx.taskLocks.run(taskId, async () => {
      const link = await ctx.store.getIssueLinkByTask(taskId);
      if (!link || link.summaryCommentId !== commentId) return;
      await ctx.store.saveIssueLink({ ...link, summaryCommentId: null, summaryHash: null });
      await pushTaskLocked(ctx, taskId, {});
      recreated.push(taskId);
    });
  }
  return recreated;
}

/** 匯入用：在持有 Task 鎖的情況下建立對應並寫出摘要留言。 */
export function linkImportedIssue(
  ctx: IntegrationContext,
  task: TaskRecord,
  repo: ConnectedRepo,
  issue: GitHubIssue,
  assignee: MemberRecord | null,
): Promise<PushOutcome> {
  return ctx.taskLocks.run(task.id, async () => {
    await ctx.store.saveIssueLink({
      taskId: task.id,
      repoId: repo.record.id,
      githubRepoId: repo.githubRepoId,
      issueNumber: issue.number,
      issueId: issue.id,
      issueUrl: issue.htmlUrl,
      summaryCommentId: null,
      summaryHash: null,
      snapshot: freshSnapshot(
        fieldsFromIssue(issue, assignee?.githubUserId ?? null),
        issue.updatedAt,
      ),
    });
    return pushTaskLocked(ctx, task.id, {});
  });
}
