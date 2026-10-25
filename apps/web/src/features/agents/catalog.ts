// 模型目錄：每個 Agent 的工具名稱、vendor、CLI 代號、可選的模型（名稱、tag、推理強度）、是否已登入與
// 登入方式。Server 彙整目前 Member 可用的 Runner 回報的 AgentAvailability（`GET agentCatalog`）。
// 設定→代理、輸入框的模型選單與派工對話框共用。

import {
  AgentCatalogResponse,
  API_ROUTES,
  type CatalogModel,
  type Effort,
  type AgentCatalogEntry as Entry,
  type ModelTag as Tag,
} from "@orbis/api-contract";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../api/client";

export type AgentCatalogEntry = Entry;
export type { CatalogModel };

/** 推理強度：快速、標準、深度。 */
export const EFFORT_LEVELS = ["fast", "std", "deep"] as const satisfies readonly Effort[];
export type EffortLevel = Effort;

/** 選單右側的 tag。 */
export type ModelTag = Tag;

export const agentCatalogQuery = queryOptions({
  queryKey: ["agent-catalog"] as const,
  queryFn: ({ signal }) => apiRequest(API_ROUTES.agentCatalog, AgentCatalogResponse, { signal }),
  staleTime: 60_000,
});

/** 模型目錄（目前 Member 可用的 Runner 上的 Agent）。 */
export function useAgentCatalog() {
  const catalog = useQuery(agentCatalogQuery);
  return { data: catalog.data ?? [], isLoading: catalog.isLoading, error: catalog.error };
}

/** 目錄中某個 Agent 的某個模型；目錄沒有列出時為 null。 */
export function findModel(
  catalog: readonly AgentCatalogEntry[],
  agentId: string,
  modelId: string,
): CatalogModel | null {
  return (
    catalog.find((entry) => entry.agentId === agentId)?.models.find((m) => m.id === modelId) ?? null
  );
}

/**
 * 模型的顯示名稱：目錄中有就用目錄的名稱；沒有時由 id 推導，例如 `claude-sonnet-5-5` → `Sonnet 5.5`、
 * `gpt-5-codex` → `GPT-5 Codex`。
 */
export function modelDisplayName(id: string, catalog?: readonly AgentCatalogEntry[]): string {
  for (const entry of catalog ?? []) {
    const found = entry.models.find((m) => m.id === id);
    if (found) return found.name;
  }
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
