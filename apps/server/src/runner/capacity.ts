// Credential 的並行上限（ARCHITECTURE §7）：每組 Credential 預設 30 個進行中的 Run，超過的排隊。
// 有效上限＝Admin 在 Server 的覆寫 ?? Runner 回報的值。撞到 rate limit 時，到恢復前不派新的 Run。
// 純函式，給 Dispatcher 與佇列狀態 API 共用。

import type { RunStatus } from "@orbis/api-contract";

/** Runner 沒有回報時的預設並行上限。 */
export const DEFAULT_CREDENTIAL_CONCURRENCY = 30;

/**
 * 佔用 Credential 名額的 Run 狀態：已派出（含 Runner 還沒接受）、執行中、等待人回覆或 Gate、
 * 暫停在 rate limit。Agent 程序在 Review Gate 期間不會結束，所以也算。
 */
export const CREDENTIAL_OCCUPYING_STATUSES = [
  "dispatched",
  "starting",
  "running",
  "awaiting_permission",
  "rate_limited",
  "awaiting_gate",
] as const satisfies readonly RunStatus[];

export function effectiveMaxConcurrency(
  override: number | null | undefined,
  reported: number | null | undefined,
): number {
  return override ?? reported ?? DEFAULT_CREDENTIAL_CONCURRENCY;
}

export interface CredentialLoad {
  /** 有效的並行上限。 */
  maxConcurrency: number;
  /** 目前佔用名額的 Run 數。 */
  active: number;
  /** 預估的 rate limit 恢復時間；沒有撞到 rate limit 時為 null。 */
  rateLimitedUntil: Date | null;
}

export type CapacityDecision =
  | { ok: true }
  | { ok: false; reason: "concurrency_limit" | "rate_limited" };

/** 這組 Credential 現在能不能再接一個 Run。 */
export function credentialCapacity(load: CredentialLoad, now: Date): CapacityDecision {
  if (load.rateLimitedUntil && load.rateLimitedUntil.getTime() > now.getTime()) {
    return { ok: false, reason: "rate_limited" };
  }
  if (load.active >= load.maxConcurrency) return { ok: false, reason: "concurrency_limit" };
  return { ok: true };
}
