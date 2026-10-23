// Run（ARCHITECTURE §4、§8、§9）：某個 Agent 為某個 Task 做的一次執行。

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { DelegationMode, PermissionPolicy, RunnerKind, RunOrigin, RunStatus } from "./enums";

const TokenCount = z.number().int().nonnegative().nullable();

/**
 * Run 的累計用量：最近一筆 `usage` Event（@orbis/protocol 的 `Usage`）的 camelCase 版本。
 * Agent 沒有回報的項目為 null；還沒有任何 `usage` Event 時全部為 null。
 * 協定新增欄位時，`resource-types.test.ts` 的型別測試會失敗，提醒同步更新。
 */
export const RunUsage = z.object({
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  thoughtTokens: TokenCount,
  cachedReadTokens: TokenCount,
  cachedWriteTokens: TokenCount,
  /** 目前 context 已使用的 token 數（不是累計值）。 */
  contextUsedTokens: TokenCount,
  contextWindowTokens: TokenCount,
  cost: z
    .object({
      amount: z.number().nonnegative(),
      /** ISO 4217 幣別代碼，例如 `USD`。 */
      currency: z.string().length(3),
    })
    .nullable(),
});
export type RunUsage = z.infer<typeof RunUsage>;

export const Run = z
  .object({
    id: Id,
    taskId: Id,
    /** Child Run 的父 Run；頂層 Run 為 null。 */
    parentRunId: Id.nullable(),
    /** Child Run 的 Delegation 模式；頂層 Run 為 null。 */
    delegationMode: DelegationMode.nullable(),
    /** Agent 的識別名稱，例如 `claude-code`。 */
    agent: z.string().min(1),
    /** 使用的 model；Agent 尚未回報時為 null。 */
    model: z.string().min(1).nullable(),
    permissionPolicy: PermissionPolicy,
    /** 要在哪裡跑：`local`＝我的電腦，`team`＝Team Runner。 */
    runnerKind: RunnerKind,
    /** 接下這個 Run 的 Runner；尚未派工時為 null。 */
    runnerId: Id.nullable(),
    /** Runner 主機上的 Worktree 路徑；Runner 建立 Worktree 之前為 null。 */
    worktreePath: z.string().min(1).nullable(),
    /** Run 的分支；Runner 建立 Worktree 之前為 null。 */
    branch: z.string().min(1).nullable(),
    /** 建立 Worktree 時的 base commit（diff 的比較對象）；Runner 建立 Worktree 之前為 null。 */
    baseCommit: z.string().min(1).nullable(),
    status: RunStatus,
    usage: RunUsage,
    /** 觸發這個 Run 的 Member；由 Delegation 產生的 Child Run 為 null。 */
    startedByMemberId: Id.nullable(),
    /** Run 為什麼產生。Child Run 樹與 Run 頁用來標示。 */
    origin: RunOrigin,
    /** 使用的 Credential（Runner 上的名稱）；還沒派工時為 null。 */
    credential: z.string().min(1).nullable(),
    /** 沒有父 Run 的 `consult` Run（@agent）唯讀讀取哪個 Run 的 Worktree；其他 Run 為 null。 */
    consultOfRunId: Id.nullable(),
    /** Feedback Loop 的 Run 接續的前一個 Run；其他 Run 為 null。 */
    resumesRunId: Id.nullable(),
    createdAt: Timestamp,
    /** Runner 開始執行的時間；尚未開始時為 null。 */
    startedAt: Timestamp.nullable(),
    /** 進入終止狀態的時間；尚未結束時為 null。 */
    endedAt: Timestamp.nullable(),
    updatedAt: Timestamp,
  })
  .refine((run) => (run.parentRunId === null) === (run.delegationMode === null), {
    error: "Child Run 必須同時有 parentRunId 與 delegationMode；頂層 Run 兩者都是 null",
    path: ["delegationMode"],
  });
export type Run = z.infer<typeof Run>;
