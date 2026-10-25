// Task（ARCHITECTURE §4、§5）：只對應一個 Repo，有唯一的 Task Key。

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { GeneralAccess, PullRequestState, TaskAccess, TaskDoneReason, TaskStatus } from "./enums";
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

/**
 * Task 的 PR（以 GitHub App 開出的那一個；有多個時是最新的）。事件串流依時間插入「開出合併請求」與
 * 「已合併」兩列。`openedAt` 是 PR 建立的時間；`mergedAt` 由 `pr_merged` webhook 寫入。
 */
export const TaskPullRequest = z.object({
  number: z.number().int().positive(),
  url: z.url(),
  state: PullRequestState,
  /** 開出 PR 的 Run；Run 被刪除時為 null。 */
  runId: Id.nullable(),
  openedAt: Timestamp,
  /** 還沒 merge 時為 null。 */
  mergedAt: Timestamp.nullable(),
});
export type TaskPullRequest = z.infer<typeof TaskPullRequest>;

export const Task = z.object({
  id: Id,
  key: TaskKey,
  projectId: Id,
  /**
   * 對應的 Repo；可以不指定（ADR-0011），這種 Task 只能停在 Backlog，補指定一次之後不能再換。
   * 進入 Ready 前必須設定（§5）。
   */
  repoId: Id.nullable(),
  title: TaskTitle,
  /** Task 描述（markdown）。小 Task 的 Spec 就是這段描述。 */
  description: z.string(),
  status: TaskStatus,
  /** 轉為 Done 的原因（GitHub 的 state_reason）；不是 Done 時為 null（§11）。 */
  doneReason: TaskDoneReason.nullable(),
  /** 指派的 Member；尚未指派時為 null。 */
  assigneeMemberId: Id.nullable(),
  /** 連結的 Repo 內 Spec；沒有時為 null。 */
  specPath: SpecPath.nullable(),
  /** 這個 Task 依賴的其他 Task 的 ID。 */
  dependsOn: z.array(Id),
  /** 覆寫 Project 的 Plan Gate 設定；null 表示沿用 Project。 */
  planGateEnabled: z.boolean().nullable(),
  /** 建立的 Member；Member 被移除或由 Agent 提出的 Draft Task 確認而來時可能為 null。 */
  createdByMemberId: Id.nullable(),
  /** Task 的 PR；還沒開 PR 或本機 Repo 時為 null。 */
  pullRequest: TaskPullRequest.nullable(),
  /** 一般存取（Task 分享，ADR-0012）。 */
  generalAccess: GeneralAccess,
  /**
   * 目前登入者在這個 Task 上的有效權限（Task 角色、一般存取與 Team／Project Role 合起來）。
   * Web UI 依它隱藏操作；實際權限一律以 Server 的判斷為準。
   */
  viewerAccess: TaskAccess,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Task = z.infer<typeof Task>;

/**
 * 建立 Task。Project 由路徑決定；Task Key 由 Server 產生；狀態一律從 Backlog 開始。
 * 可以不指定 Repo（`repoId` 為 null），之後以 UpdateTaskInput 補指定一次。建立的人是 Task 的擁有者。
 */
export const CreateTaskInput = z
  .object({
    repoId: Id.nullable().default(null),
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
 * 更新 Task 的欄位，只送要改的欄位，至少一個。狀態要經由 Task 狀態機轉換，不在這裡改。
 * `repoId` 只能從 null 補指定一次（ADR-0011）：已經指定時回 409 `repo_already_set`。
 */
export const UpdateTaskInput = z
  .object({
    repoId: Id,
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

/**
 * 要求 Task 轉換到另一個狀態；是否合法由 Server 的 Task 狀態機判斷。
 * 沒有 Repo 的 Task 移到 Ready 時回 409 `repo_required`。
 */
export const TransitionTaskInput = z.object({
  status: TaskStatus,
});
export type TransitionTaskInput = z.infer<typeof TransitionTaskInput>;
