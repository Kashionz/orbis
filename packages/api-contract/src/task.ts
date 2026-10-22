// Task（ARCHITECTURE §4、§5）：只對應一個 Repo，有唯一的 Task Key。

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { TaskStatus } from "./enums";
import type { ProjectKeyPrefix } from "./project";

const TASK_KEY_PATTERN = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]*)$/;

/** Task Key：`<Project 前綴>-<流水號>`，例如 `ORB-12`。流水號從 1 開始，不補零。 */
export const TaskKey = z.string().regex(TASK_KEY_PATTERN, {
  error: "Task Key 的格式必須是 <Project 前綴>-<流水號>，例如 ORB-12",
});
export type TaskKey = z.infer<typeof TaskKey>;

/** 拆出 Task Key 的 Project 前綴與流水號；格式不符時回傳 null。 */
export function parseTaskKey(key: string): { prefix: ProjectKeyPrefix; number: number } | null {
  const match = TASK_KEY_PATTERN.exec(key);
  if (!match?.[1] || !match[2]) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return null;
  return { prefix: match[1], number };
}

/** 由 Project 前綴與流水號組出 Task Key。 */
export function formatTaskKey(prefix: ProjectKeyPrefix, number: number): TaskKey {
  return TaskKey.parse(`${prefix}-${number}`);
}

const TaskTitle = z.string().trim().min(1).max(200);

/** Repo 內的 Spec 路徑（相對於 repo 根目錄，以 `/` 分隔）。 */
const SpecPath = z.string().min(1);

export const Task = z.object({
  id: Id,
  key: TaskKey,
  projectId: Id,
  repoId: Id,
  title: TaskTitle,
  /** Task 描述（markdown）。小 Task 的 Spec 就是這段描述。 */
  description: z.string(),
  status: TaskStatus,
  /** 指派的 Member；尚未指派時為 null。 */
  assigneeMemberId: Id.nullable(),
  /** 連結的 Repo 內 Spec；沒有時為 null。 */
  specPath: SpecPath.nullable(),
  /** 這個 Task 依賴的其他 Task 的 ID。 */
  dependsOn: z.array(Id),
  /** 覆寫 Project 的 Plan Gate 設定；null 表示沿用 Project。 */
  planGateEnabled: z.boolean().nullable(),
  createdByMemberId: Id,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Task = z.infer<typeof Task>;

/** 建立 Task。Project 由路徑決定；Task Key 由 Server 產生；狀態一律從 Backlog 開始。 */
export const CreateTaskInput = z
  .object({
    repoId: Id,
    title: TaskTitle,
    description: z.string().default(""),
    assigneeMemberId: Id.nullable().default(null),
    specPath: SpecPath.nullable().default(null),
    dependsOn: z.array(Id).default([]),
    planGateEnabled: z.boolean().nullable().default(null),
  })
  .strict();
export type CreateTaskInput = z.input<typeof CreateTaskInput>;

/**
 * 更新 Task 的欄位，只送要改的欄位，至少一個。
 * Repo 建立後不能更換（ADR-0011）；狀態要經由 Task 狀態機轉換，不在這裡改。
 */
export const UpdateTaskInput = z
  .object({
    title: TaskTitle,
    description: z.string(),
    assigneeMemberId: Id.nullable(),
    specPath: SpecPath.nullable(),
    dependsOn: z.array(Id),
    planGateEnabled: z.boolean().nullable(),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, { error: "至少要更新一個欄位" });
export type UpdateTaskInput = z.input<typeof UpdateTaskInput>;

/** 要求 Task 轉換到另一個狀態；是否合法由 Server 的 Task 狀態機判斷。 */
export const TransitionTaskInput = z.object({
  status: TaskStatus,
});
export type TransitionTaskInput = z.infer<typeof TransitionTaskInput>;
