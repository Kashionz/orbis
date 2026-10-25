// 模型目錄（後端缺口 `model-catalog`）：每個 Agent 的顯示資訊、可以選的 model 與推理強度、
// 是否已登入。Server 彙整目前 Member 可用的 Runner（自己的 Local Runner 與 Team Runner）回報的
// AgentAvailability；同一個 Agent 在多台 Runner 上時合併成一筆。

import { z } from "zod";
import { Effort, LoginHintKind, ModelSource, ModelTag } from "./enums";

/** model 的推理強度能力（協定的 EffortSupport）。 */
export const EffortSupport = z.discriminatedUnion("kind", [
  /** 可以選快速、標準、深度。 */
  z.object({ kind: z.literal("adjustable") }),
  /** 固定為某個等級。 */
  z.object({ kind: z.literal("fixed"), level: Effort }),
  /** 不支援推理強度。 */
  z.object({ kind: z.literal("unsupported") }),
]);
export type EffortSupport = z.infer<typeof EffortSupport>;

export const CatalogModel = z.object({
  /** 送給 Agent 的 model id，例如 `claude-sonnet-5-5`。 */
  id: z.string().min(1),
  /** 顯示名稱，例如 `Sonnet 5.5`（專有名詞，不翻譯）。 */
  name: z.string().min(1),
  tag: ModelTag.nullable(),
  effort: EffortSupport,
  source: ModelSource,
});
export type CatalogModel = z.infer<typeof CatalogModel>;

/** 怎麼登入或重新登入。`runner`：Desktop 在這台電腦上執行；`cli`：在終端機執行。 */
export const LoginHint = z.object({ kind: LoginHintKind, command: z.string().min(1) });
export type LoginHint = z.infer<typeof LoginHint>;

export const AgentCatalogEntry = z.object({
  /** Agent Profile 的 id，例如 `claude-code`。 */
  agentId: z.string().min(1),
  /** 工具名稱，例如 `Claude Code`。 */
  tool: z.string().min(1),
  /** 廠商，例如 `Anthropic`；不知道時為 null。 */
  vendor: z.string().nullable(),
  /** CLI 代號，例如 `claude`；不知道時為 null。 */
  cliId: z.string().nullable(),
  models: z.array(CatalogModel),
  /** 是否已登入；任何一台 Runner 回報已登入就是 true。所有 Runner 都無法得知時為 null。 */
  signedIn: z.boolean().nullable(),
  loginHint: LoginHint.nullable(),
});
export type AgentCatalogEntry = z.infer<typeof AgentCatalogEntry>;

/** `GET` agentCatalog 的回應，依 Agent 的顯示順序。 */
export const AgentCatalogResponse = z.array(AgentCatalogEntry);
export type AgentCatalogResponse = z.infer<typeof AgentCatalogResponse>;
