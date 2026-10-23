// Task 留言（ARCHITECTURE §12.3）。內文是 markdown，@mention 用 `mention.ts` 的明確寫法。
// @agent 會在這個 Task 上建立 `consult` Run；Run 結束後 Agent 的回覆貼回成一則留言（作者是那個 Run）。

import { z } from "zod";
import { Id, Timestamp } from "./common";

const CommentBody = z.string().trim().min(1).max(20_000);

export const TaskComment = z
  .object({
    id: Id,
    taskId: Id,
    /** Member 寫的留言；Agent 的回覆為 null。 */
    authorMemberId: Id.nullable(),
    /** Agent 的回覆所屬的 Run；Member 寫的留言為 null。 */
    authorRunId: Id.nullable(),
    body: z.string().min(1),
    /** 這則留言中的 @agent 建立的 `consult` Run。 */
    consultRunIds: z.array(Id),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .refine((c) => c.authorRunId === null || c.authorMemberId === null, {
    error: "留言的作者是 Member 或 Run 其中之一",
    path: ["authorRunId"],
  });
export type TaskComment = z.infer<typeof TaskComment>;

/** `GET` taskComments 的回應，依時間排序（舊的在前）。 */
export const TaskCommentListResponse = z.array(TaskComment);
export type TaskCommentListResponse = z.infer<typeof TaskCommentListResponse>;

/** 新增留言（`POST` taskComments）。回應是建立的 `TaskComment`，帶 @agent 建立的 Run。 */
export const CreateTaskCommentInput = z.object({ body: CommentBody }).strict();
export type CreateTaskCommentInput = z.infer<typeof CreateTaskCommentInput>;

/** 修改自己的留言（`PATCH` taskComment）。新增的 @mention 才會通知或建立 Run。 */
export const UpdateTaskCommentInput = z.object({ body: CommentBody }).strict();
export type UpdateTaskCommentInput = z.infer<typeof UpdateTaskCommentInput>;
