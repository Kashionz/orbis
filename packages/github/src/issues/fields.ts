// 同步欄位（ARCHITECTURE §11：title、body、state、assignee、labels）的正規化與比較。

import type { GitHubIssue } from "../client/types";
import type { IssueSnapshot, SyncedField, TaskRecord } from "../ports";

export const SYNCED_FIELDS: readonly SyncedField[] = [
  "title",
  "body",
  "state",
  "assignee",
  "labels",
];

export interface IssueFields {
  title: string;
  body: string;
  state: "open" | "closed";
  /** GitHub user id。 */
  assignee: number | null;
  labels: string[];
}

/** GitHub 網頁編輯的內容是 CRLF；比較與寫回 Task 前一律換成 LF。 */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n");
}

export function normalizeLabels(labels: readonly string[]): string[] {
  return [...new Set(labels)].sort();
}

/** Task 狀態對應到 Issue state：只有 Done 是 closed。 */
export function issueStateOf(task: Pick<TaskRecord, "status">): "open" | "closed" {
  return task.status === "done" ? "closed" : "open";
}

/** Task 目前希望 Issue 呈現的欄位。`assignee` 是負責人的 GitHub user id。 */
export function fieldsFromTask(task: TaskRecord, assigneeGithubUserId: number | null): IssueFields {
  return {
    title: task.title,
    body: normalizeBody(task.description),
    state: issueStateOf(task),
    assignee: assigneeGithubUserId,
    labels: normalizeLabels(task.labels),
  };
}

/** Issue 目前的欄位。`assignee` 由呼叫端對應（第一個屬於 Team 的 assignee）。 */
export function fieldsFromIssue(issue: GitHubIssue, assignee: number | null): IssueFields {
  return {
    title: issue.title,
    body: normalizeBody(issue.body),
    state: issue.state,
    assignee,
    labels: normalizeLabels(issue.labels),
  };
}

export function sameValue(a: IssueFields[SyncedField], b: IssueFields[SyncedField]): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** 兩組欄位中值不同的欄位。 */
export function differentFields(a: IssueFields, b: IssueFields): SyncedField[] {
  return SYNCED_FIELDS.filter((field) => !sameValue(a[field], b[field]));
}

export function snapshotFields(snapshot: IssueSnapshot): IssueFields {
  return {
    title: snapshot.title,
    body: snapshot.body,
    state: snapshot.state,
    assignee: snapshot.assignee,
    labels: snapshot.labels,
  };
}

/** 全部欄位都以同一個時間點同步的快照（第一次建立對應時）。 */
export function freshSnapshot(fields: IssueFields, syncedAt: string): IssueSnapshot {
  return {
    ...fields,
    syncedAt: {
      title: syncedAt,
      body: syncedAt,
      state: syncedAt,
      assignee: syncedAt,
      labels: syncedAt,
    },
  };
}

/** 把部分欄位更新進快照，並記下這些欄位的同步時間。 */
export function updateSnapshot(
  snapshot: IssueSnapshot,
  fields: IssueFields,
  changed: readonly SyncedField[],
  syncedAt: string,
): IssueSnapshot {
  const next: IssueSnapshot = { ...snapshot, syncedAt: { ...snapshot.syncedAt } };
  for (const field of changed) {
    switch (field) {
      case "title":
        next.title = fields.title;
        break;
      case "body":
        next.body = fields.body;
        break;
      case "state":
        next.state = fields.state;
        break;
      case "assignee":
        next.assignee = fields.assignee;
        break;
      case "labels":
        next.labels = fields.labels;
        break;
    }
    next.syncedAt[field] = syncedAt;
  }
  return next;
}

/** ISO 8601 的先後比較。 */
export function isAfter(a: string | Date, b: string | Date): boolean {
  return new Date(a).getTime() > new Date(b).getTime();
}
