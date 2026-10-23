// Draft Task（ARCHITECTURE §9）：Agent 以 `propose_tasks` 提出、經人確認後才進入 Backlog 的 Task。

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { AcceptanceCriterionKind } from "./enums";
import { Task } from "./task";

/** Draft Task 提議的一條 Acceptance Criterion。 */
export const DraftAcceptanceCriterion = z
  .object({
    kind: AcceptanceCriterionKind,
    description: z.string().trim().min(1),
    /** 只有 `command` 類型可以有值；null 表示沿用 Repo 設定檔的 `verify`。 */
    command: z.string().trim().min(1).nullable(),
  })
  .refine((c) => c.kind === "command" || c.command === null, {
    error: "只有 command 類型可以設定指令",
    path: ["command"],
  });
export type DraftAcceptanceCriterion = z.infer<typeof DraftAcceptanceCriterion>;

/**
 * 依賴：同一批的另一個 Draft Task（`#<n>`，從 1 開始，對應 `position`），或既有的 Task Key。
 * - 確認時 Server 換成實際的 Task；依賴的 Draft Task 還沒確認時回 409。
 * - 批次確認依相依順序建立（被依賴的先建立）。
 * - 確認後，同一批其他草稿中指向它的 `#<n>` 改寫成新的 Task Key。
 * - 捨棄某一筆時，同一批其他草稿中指向它的相依直接移除。
 */
const DraftDependency = z.string().regex(/^(#[1-9][0-9]*|[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*)$/, {
  error: "依賴必須是 #<n> 或 Task Key",
});

export const DraftTask = z.object({
  id: Id,
  projectId: Id,
  /** 同一次 `propose_tasks` 的批次。 */
  batchId: Id,
  /** 在批次中的順序，從 1 開始（`#<n>` 的 n）。 */
  position: z.number().int().positive(),
  /** 提出的 Run；Run 被刪除後為 null。 */
  proposedByRunId: Id.nullable(),
  repoId: Id.nullable(),
  /** `propose_tasks` 的 spec 參數（Spec 內容或 Repo 內 Spec 的路徑）。 */
  spec: z.string().nullable(),
  title: z.string().min(1),
  description: z.string(),
  acceptanceCriteria: z.array(DraftAcceptanceCriterion),
  dependsOn: z.array(DraftDependency),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type DraftTask = z.infer<typeof DraftTask>;

/** `GET` projectDraftTasks 的回應：還沒確認也沒捨棄的 Draft Task，依批次與順序排列。 */
export const DraftTaskListResponse = z.array(DraftTask);
export type DraftTaskListResponse = z.infer<typeof DraftTaskListResponse>;

/** 修改 Draft Task（`PATCH` draftTask），至少一個欄位。 */
export const UpdateDraftTaskInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string(),
    repoId: Id.nullable(),
    acceptanceCriteria: z.array(DraftAcceptanceCriterion),
    dependsOn: z.array(DraftDependency),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, { error: "至少要更新一個欄位" });
export type UpdateDraftTaskInput = z.input<typeof UpdateDraftTaskInput>;

/** 確認一個 Draft Task（`POST` draftTaskConfirm），回傳建立的 Task（狀態為 Backlog）。 */
export const ConfirmDraftTaskResponse = Task;
export type ConfirmDraftTaskResponse = z.infer<typeof ConfirmDraftTaskResponse>;

/** 批次確認或捨棄（`POST` projectDraftTasksConfirm／projectDraftTasksDismiss），一次 1–100 個。 */
export const DraftTaskBatchInput = z.object({ draftTaskIds: z.array(Id).min(1).max(100) }).strict();
export type DraftTaskBatchInput = z.infer<typeof DraftTaskBatchInput>;

/** 批次確認的回應：每個 Draft Task 建立的 Task，依輸入的順序。 */
export const ConfirmDraftTasksResponse = z.array(z.object({ draftTaskId: Id, task: Task }));
export type ConfirmDraftTasksResponse = z.infer<typeof ConfirmDraftTasksResponse>;
