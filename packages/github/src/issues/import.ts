// 從 GitHub Issue 匯入成 Task。新開的 Issue 不會自動變成 Task，只能透過這裡匯入
// （同一個 GitHub repo 可能登記在多個 Project，自動匯入不知道要放到哪裡）。

import { type ConnectedRepo, connectedRepo, type IntegrationContext } from "../context";
import { normalizeBody, normalizeLabels } from "./fields";
import { linkImportedIssue, mapAssignee } from "./sync";

export class RepoNotConnectedError extends Error {
  override name = "RepoNotConnectedError";
  constructor(readonly repoId: string) {
    super(`Repo ${repoId} 不存在或沒有安裝 GitHub App`);
  }
}

export interface ImportableIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
  assignees: string[];
  updatedAt: string;
}

async function requireRepo(ctx: IntegrationContext, repoId: string): Promise<ConnectedRepo> {
  const record = await ctx.domain.getRepo(repoId);
  const repo = record && connectedRepo(record);
  if (!repo) throw new RepoNotConnectedError(repoId);
  return repo;
}

/** 這個 Repo 中還沒匯入到它所屬 Project 的 open Issue（不含 PR）。 */
export async function listImportableIssues(
  ctx: IntegrationContext,
  repoId: string,
): Promise<ImportableIssue[]> {
  const repo = await requireRepo(ctx, repoId);
  const issues = await ctx.client.listOpenIssues(repo.installationId, repo.ref);
  const result: ImportableIssue[] = [];
  for (const issue of issues) {
    const links = await ctx.store.findIssueLinks(repo.githubRepoId, issue.number);
    if (links.some((link) => link.repoId === repoId)) continue;
    result.push({
      number: issue.number,
      title: issue.title,
      url: issue.htmlUrl,
      labels: issue.labels,
      assignees: issue.assignees.map((a) => a.login),
      updatedAt: issue.updatedAt,
    });
  }
  return result;
}

export type ImportResult =
  | { issueNumber: number; status: "imported"; taskId: string }
  | { issueNumber: number; status: "already_linked"; taskId: string }
  | { issueNumber: number; status: "not_found" | "closed" };

/** 把選定的 Issue 匯入成 Task。已經匯入過的 Issue 回傳原本的 Task，不會重複建立。 */
export async function importIssues(
  ctx: IntegrationContext,
  input: { repoId: string; issueNumbers: readonly number[]; importedByMemberId: string },
): Promise<ImportResult[]> {
  const repo = await requireRepo(ctx, input.repoId);
  const results: ImportResult[] = [];
  for (const issueNumber of new Set(input.issueNumbers)) {
    const links = await ctx.store.findIssueLinks(repo.githubRepoId, issueNumber);
    const existing = links.find((link) => link.repoId === input.repoId);
    if (existing) {
      results.push({ issueNumber, status: "already_linked", taskId: existing.taskId });
      continue;
    }

    const issue = await ctx.client.getIssue(repo.installationId, repo.ref, issueNumber);
    if (!issue || issue.isPullRequest) {
      results.push({ issueNumber, status: "not_found" });
      continue;
    }
    // 匯入的 Task 從 Backlog 開始；已關閉的 Issue 匯入後會被重新打開，所以不接受。
    if (issue.state === "closed") {
      results.push({ issueNumber, status: "closed" });
      continue;
    }

    const assignee = await mapAssignee(ctx, repo.record.projectId, issue.assignees);
    const task = await ctx.domain.createTaskFromIssue({
      repoId: input.repoId,
      title: issue.title,
      description: normalizeBody(issue.body),
      labels: normalizeLabels(issue.labels),
      assigneeMemberId: assignee?.id ?? null,
      createdByMemberId: input.importedByMemberId,
    });
    await linkImportedIssue(ctx, task, repo, issue, assignee);
    ctx.logger.info({ taskId: task.id, issue: issue.htmlUrl }, "已從 GitHub Issue 匯入 Task");
    results.push({ issueNumber, status: "imported", taskId: task.id });
  }
  return results;
}
