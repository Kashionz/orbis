// Credential 的並行與用量、Team Runner 的佇列（ARCHITECTURE §7）。
//
// Credential 本身只存在 Runner 主機上（ADR-0007），Server 只知道各 Runner 回報的名稱與並行上限。
// Admin 可以在 Server 覆寫並行上限：有效上限＝覆寫 ?? Runner 回報（預設 30）。
// Credential 撞到 rate limit 時，到恢復前不派新的 Run 給它。

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { RunnerKind } from "./enums";
import { TaskKey } from "./task";

const TokenCount = z.number().int().nonnegative();

/** 一台 Runner 上的一組 Credential。 */
export const CredentialStatus = z.object({
  runnerId: Id,
  runnerName: z.string(),
  runnerKind: RunnerKind,
  /** Runner 目前是否連線中。 */
  online: z.boolean(),
  /** Runner 上的 Credential 名稱。 */
  credential: z.string().min(1),
  /** 使用這組 Credential 的 Agent。 */
  agents: z.array(z.string().min(1)),
  /** Runner 回報的並行上限。 */
  reportedMaxConcurrentRuns: z.number().int().positive(),
  /** Admin 的覆寫；沒有覆寫時為 null。 */
  maxConcurrentRunsOverride: z.number().int().positive().nullable(),
  /** 有效上限：覆寫 ?? Runner 回報。 */
  maxConcurrentRuns: z.number().int().positive(),
  /** 進行中的 Run 數（含 Child Run）。 */
  activeRuns: z.number().int().nonnegative(),
  /** 等待這組 Credential 的 Run 數。 */
  queuedRuns: z.number().int().nonnegative(),
  /** rate limit 預估恢復的時間；沒有在 rate limit 中為 null。 */
  rateLimitedUntil: Timestamp.nullable(),
  /** 最近 24 小時開始的 Run 的累計用量；Agent 沒有回報的項目為 null。 */
  usage24h: z.object({
    runs: z.number().int().nonnegative(),
    inputTokens: TokenCount.nullable(),
    outputTokens: TokenCount.nullable(),
    cost: z.object({ amount: z.number().nonnegative(), currency: z.string().length(3) }).nullable(),
  }),
});
export type CredentialStatus = z.infer<typeof CredentialStatus>;

/** `GET` credentials 的回應：Team 中所有 Runner 的 Credential。 */
export const CredentialListResponse = z.array(CredentialStatus);
export type CredentialListResponse = z.infer<typeof CredentialListResponse>;

/** 覆寫並行上限（`PATCH` runnerCredential，Admin 以上）。null 表示取消覆寫。 */
export const UpdateRunnerCredentialInput = z
  .object({ maxConcurrentRuns: z.number().int().min(1).max(1000).nullable() })
  .strict();
export type UpdateRunnerCredentialInput = z.infer<typeof UpdateRunnerCredentialInput>;

/** Run 還在佇列中的原因。 */
export const QUEUE_WAITING_REASONS = [
  /** 沒有在線、接受派工的 Runner。 */
  "no_runner",
  /** 能跑的 Runner 都沒有這個 Agent，或 Agent 目前無法使用。 */
  "agent_unavailable",
  /** Credential 已達並行上限。 */
  "concurrency_limit",
  /** Credential 在 rate limit 中。 */
  "rate_limited",
] as const;
export const QueueWaitingReason = z.enum(QUEUE_WAITING_REASONS);
export type QueueWaitingReason = z.infer<typeof QueueWaitingReason>;

/** Team Runner 佇列中的一個 Run。 */
export const TeamRunnerQueueItem = z.object({
  runId: Id,
  taskId: Id,
  taskKey: TaskKey,
  agent: z.string().min(1),
  /** 在佇列中的順位，從 1 開始。 */
  position: z.number().int().positive(),
  waitingReason: QueueWaitingReason,
  queuedAt: Timestamp,
});
export type TeamRunnerQueueItem = z.infer<typeof TeamRunnerQueueItem>;

/** `GET` teamRunnerQueue 的回應，依順位排列。 */
export const TeamRunnerQueueResponse = z.array(TeamRunnerQueueItem);
export type TeamRunnerQueueResponse = z.infer<typeof TeamRunnerQueueResponse>;
