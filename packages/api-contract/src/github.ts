// GitHub 整合給 Web 用的資源（ARCHITECTURE §11）：從 Issue 匯入 Task。
// 端點由 Server 依 API_ROUTES 提供，實作呼叫 packages/github。

import { z } from "zod";
import { Id, Timestamp } from "./common";

/** Repo 中還沒有對應到這個 Project 任何 Task 的 open Issue（不含 PR）。 */
export const ImportableIssue = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.url(),
  labels: z.array(z.string()),
  /** GitHub login。 */
  assignees: z.array(z.string()),
  updatedAt: Timestamp,
});
export type ImportableIssue = z.infer<typeof ImportableIssue>;

/** 把選定的 Issue 匯入成 Task（一次 1–100 個）。 */
export const ImportIssuesInput = z
  .object({ issueNumbers: z.array(z.number().int().positive()).min(1).max(100) })
  .strict();
export type ImportIssuesInput = z.infer<typeof ImportIssuesInput>;

export const IMPORT_ISSUE_STATUSES = ["imported", "already_linked", "not_found", "closed"] as const;

/** 每個 Issue 的匯入結果。`imported` 與 `already_linked` 時帶對應的 Task。 */
export const ImportIssueResult = z.object({
  issueNumber: z.number().int().positive(),
  status: z.enum(IMPORT_ISSUE_STATUSES),
  taskId: Id.optional(),
});
export type ImportIssueResult = z.infer<typeof ImportIssueResult>;
