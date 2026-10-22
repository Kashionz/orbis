// Runner、AgentAvailability 與 Pairing token（ARCHITECTURE §6.1、§7、§16）。

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { RunnerKind } from "./enums";

/** Runner 回報的一個 Agent 與 Credential 的組合（Credential 本身不上傳，只有名稱）。 */
export const AgentAvailabilityItem = z.object({
  /** Agent Profile 的 id，例如 `claude-code`。 */
  agent: z.string().min(1),
  /** Runner 自訂的 Credential 名稱。 */
  credential: z.string(),
  available: z.boolean(),
  maxConcurrency: z.number().int().positive(),
  /** Runner 回報的其他資訊（版本、model、能力、無法使用的原因）；格式保留彈性。 */
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type AgentAvailabilityItem = z.infer<typeof AgentAvailabilityItem>;

export const Runner = z.object({
  id: Id,
  teamId: Id,
  kind: RunnerKind,
  /** Local Runner 綁定的 Member；Team Runner 為 null。 */
  memberId: Id.nullable(),
  name: z.string(),
  runnerVersion: z.string(),
  os: z.string(),
  arch: z.string(),
  /** 目前是否連線中。 */
  online: z.boolean(),
  /** 是否接受新的 Dispatch（Desktop 的「暫停領取」）。 */
  acceptingDispatches: z.boolean(),
  lastHeartbeatAt: Timestamp.nullable(),
  agents: z.array(AgentAvailabilityItem),
  createdAt: Timestamp,
});
export type Runner = z.infer<typeof Runner>;

/**
 * 建立 Pairing token。`local` 綁定呼叫者本人（Member 以上，Desktop 登入後呼叫）；
 * `team` 需要 Admin 以上。
 */
export const CreatePairingTokenInput = z.object({ kind: RunnerKind }).strict();
export type CreatePairingTokenInput = z.infer<typeof CreatePairingTokenInput>;

/** 建立 Pairing token 的回應；token 原文只在這裡出現一次，Server 只存 hash。 */
export const PairingTokenCreated = z.object({
  id: Id,
  kind: RunnerKind,
  token: z.string().min(1),
  expiresAt: Timestamp,
});
export type PairingTokenCreated = z.infer<typeof PairingTokenCreated>;
