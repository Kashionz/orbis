// 模型目錄（README State Management）：每個 Agent 的工具名稱、vendor、CLI 代號、可選的模型
// （名稱、tag、推理強度）與是否已登入。設定→代理與輸入框的模型選單共用。
//
// TODO(backend, model-catalog)：後端還沒有目錄 API。真實模式由 dispatch-options（各 Runner 回報的
// AgentAvailability）推導，tag、推理強度、vendor 用下方的前端靜態表；mock 模式由 MSW 提供完整目錄。

import type { DispatchOptions } from "@orbis/api-contract";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest } from "../../api/client";
import { dispatchOptionsQuery } from "../../api/resources";
import { isFeatureEnabled } from "../../lib/features";

/** 推理強度：快速、標準、深度。 */
export const EFFORT_LEVELS = ["fast", "std", "deep"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** 模型的推理強度：可調整、固定為某個等級、不支援。 */
export const ModelEffort = z.union([
  z.literal("adjustable"),
  z.literal("none"),
  z.templateLiteral(["fixed:", z.enum(EFFORT_LEVELS)]),
]);
export type ModelEffort = z.infer<typeof ModelEffort>;

/** 選單右側的 tag。 */
export const MODEL_TAGS = ["best", "balanced", "fast", "coding"] as const;
export type ModelTag = (typeof MODEL_TAGS)[number];

export const CatalogModel = z.object({
  id: z.string().min(1),
  /** 顯示名稱，例如 `Sonnet 4.5`（專有名詞，不翻譯）。 */
  name: z.string().min(1),
  tag: z.enum(MODEL_TAGS).nullable(),
  effort: ModelEffort,
});
export type CatalogModel = z.infer<typeof CatalogModel>;

/** 暫定的目錄 API 回應（資料形狀照 README State Management；不在 @orbis/api-contract 中）。 */
export const AgentCatalogEntry = z.object({
  /** Agent Profile 的 id，例如 `claude-code`。 */
  agentId: z.string().min(1),
  /** 工具名稱，例如 `Claude Code`。 */
  tool: z.string(),
  vendor: z.string(),
  /** CLI 代號，例如 `claude`。 */
  cliId: z.string(),
  models: z.array(CatalogModel),
  signedIn: z.boolean(),
});
export type AgentCatalogEntry = z.infer<typeof AgentCatalogEntry>;

/** 暫定的目錄 API 路徑（不在 @orbis/api-contract 中，只有 mock 提供）。 */
export const AGENT_CATALOG_PATH = "/api/agent-catalog";

interface AgentBrand {
  tool: string;
  vendor: string;
  cliId: string;
}

/** 已知 Agent 的工具名稱與 vendor（顯示順序也照這個）。 */
export const AGENT_BRANDS: Record<string, AgentBrand> = {
  "claude-code": { tool: "Claude Code", vendor: "Anthropic", cliId: "claude" },
  codex: { tool: "Codex", vendor: "OpenAI", cliId: "codex" },
  antigravity: { tool: "Antigravity", vendor: "Google", cliId: "agy" },
  "grok-build": { tool: "Grok Build", vendor: "xAI", cliId: "grok" },
};

/** 已知模型的顯示名稱、tag 與推理強度；不在表中的模型名稱由 id 推導，推理強度視為可調整。 */
const KNOWN_MODELS: Record<string, Omit<CatalogModel, "id">> = {
  "claude-opus-5-5": { name: "Opus 5.5", tag: "best", effort: "adjustable" },
  "claude-sonnet-5-5": { name: "Sonnet 5.5", tag: "balanced", effort: "adjustable" },
  "claude-haiku-5-5": { name: "Haiku 5.5", tag: "fast", effort: "fixed:fast" },
  "opus-4.1": { name: "Opus 4.1", tag: "best", effort: "adjustable" },
  "sonnet-4.5": { name: "Sonnet 4.5", tag: "balanced", effort: "adjustable" },
  "haiku-4.5": { name: "Haiku 4.5", tag: "fast", effort: "fixed:fast" },
  "gpt-5": { name: "GPT-5", tag: "best", effort: "adjustable" },
  "gpt-5-mini": { name: "GPT-5 Mini", tag: "fast", effort: "adjustable" },
  "gpt-5-codex": { name: "GPT-5 Codex", tag: "coding", effort: "adjustable" },
  "gemini-2.5-pro": { name: "Gemini 2.5 Pro", tag: "best", effort: "adjustable" },
  "gemini-2.5-flash": { name: "Gemini 2.5 Flash", tag: "fast", effort: "adjustable" },
  "grok-4": { name: "Grok 4", tag: "best", effort: "none" },
  "grok-code-fast-1": { name: "Grok Code Fast 1", tag: "coding", effort: "none" },
};

/** 由模型 id 推導顯示名稱：`claude-sonnet-5-5` → `Sonnet 5.5`、`gpt-5-codex` → `GPT-5 Codex`。 */
export function modelDisplayName(id: string): string {
  const known = KNOWN_MODELS[id];
  if (known) return known.name;
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  if (claude) {
    const [, family = "", major, minor] = claude;
    return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`;
  }
  return id
    .split("-")
    .map((word, index, words) => {
      if (/^gpt$/i.test(word)) return words[index + 1] ? `GPT-${words[index + 1]}` : "GPT";
      if (index > 0 && /^gpt$/i.test(words[index - 1] ?? "")) return "";
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .filter(Boolean)
    .join(" ");
}

export function catalogModel(id: string): CatalogModel {
  const known = KNOWN_MODELS[id];
  return known
    ? { id, ...known }
    : { id, name: modelDisplayName(id), tag: null, effort: "adjustable" };
}

function brandOf(agentId: string): AgentBrand {
  return AGENT_BRANDS[agentId] ?? { tool: agentId, vendor: "", cliId: agentId };
}

/** 把 dispatch-options 的 Local 與 Team 兩邊的 Agent 合併成目錄（真實模式）。 */
export function catalogFromDispatchOptions(options: DispatchOptions): AgentCatalogEntry[] {
  const merged = new Map<string, { models: Set<string>; available: boolean }>();
  for (const target of [options.local, options.team]) {
    for (const agent of target?.agents ?? []) {
      const entry = merged.get(agent.id) ?? { models: new Set<string>(), available: false };
      for (const model of agent.models) entry.models.add(model);
      entry.available ||= agent.available;
      merged.set(agent.id, entry);
    }
  }
  const order = Object.keys(AGENT_BRANDS);
  return [...merged.entries()]
    .sort(([a], [b]) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib) || a.localeCompare(b);
    })
    .map(([agentId, entry]) => ({
      agentId,
      ...brandOf(agentId),
      models: [...entry.models].map(catalogModel),
      signedIn: entry.available,
    }));
}

/**
 * 模型目錄。`projectId` 決定真實模式下用哪個 Project 的 dispatch-options（Project 的政策會影響
 * 能不能用 Team Runner）；沒有 Project 時回空陣列。
 */
export function useAgentCatalog(projectId: string | undefined) {
  const fromApi = isFeatureEnabled("modelCatalog");
  const catalog = useQuery({
    queryKey: ["agent-catalog"],
    queryFn: ({ signal }) => apiRequest(AGENT_CATALOG_PATH, z.array(AgentCatalogEntry), { signal }),
    enabled: fromApi,
    staleTime: 60_000,
  });
  const derived = useQuery({
    ...dispatchOptionsQuery(projectId ?? ""),
    enabled: !fromApi && projectId !== undefined,
    select: catalogFromDispatchOptions,
  });
  const source = fromApi ? catalog : derived;
  return { data: source.data ?? [], isLoading: source.isLoading, error: source.error };
}
