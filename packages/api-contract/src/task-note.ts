// Task note：Task 上的進度或決策紀錄。來源是 Agent 的 `update_task_note`（ARCHITECTURE §9），
// 或 Feedback Loop 每次自動修正的紀錄（§5.2）。只能由系統寫入，Web 只讀。

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { TaskNoteSource } from "./enums";

export const TaskNote = z.object({
  id: Id,
  taskId: Id,
  /** 寫下這則紀錄的 Run（Agent），或 Feedback Loop 修正用的 Run；Run 被刪除後為 null。 */
  runId: Id.nullable(),
  source: TaskNoteSource,
  /** markdown。 */
  body: z.string().min(1),
  /** 相關的連結，例如 Feedback Loop 在 PR 上的紀錄留言；沒有時為 null。 */
  url: z.url().nullable(),
  createdAt: Timestamp,
});
export type TaskNote = z.infer<typeof TaskNote>;

/** `GET` taskNotes 的回應，依時間排序（新的在前）。 */
export const TaskNoteListResponse = z.array(TaskNote);
export type TaskNoteListResponse = z.infer<typeof TaskNoteListResponse>;
