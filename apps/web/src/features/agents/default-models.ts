// 每個代理的預設模型（設定→代理）。存在這台裝置的 localStorage；輸入框派工時的預設模型也讀這裡。
// 沒有設定的代理用目錄中的第一個模型。

import { persistentState, usePersistentState } from "../../lib/storage";
import type { AgentCatalogEntry } from "./catalog";

type DefaultModels = Readonly<Record<string, string>>;

function parse(raw: string): DefaultModels | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const entries = Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return Object.fromEntries(entries);
  } catch {
    return undefined;
  }
}

export const agentDefaultModelsState = persistentState<DefaultModels>(
  "agent-models",
  {},
  parse,
  (value) => JSON.stringify(value),
);

/** 代理的預設模型 id：有設定且還在目錄中時用設定的，否則用第一個模型；沒有模型時為 null。 */
export function defaultModelOf(entry: AgentCatalogEntry, saved: DefaultModels): string | null {
  const chosen = saved[entry.agentId];
  if (chosen && entry.models.some((model) => model.id === chosen)) return chosen;
  return entry.models[0]?.id ?? null;
}

export function useAgentDefaultModels() {
  const [saved, setSaved] = usePersistentState(agentDefaultModelsState);
  return {
    saved,
    defaultModelOf: (entry: AgentCatalogEntry) => defaultModelOf(entry, saved),
    setDefaultModel: (agentId: string, modelId: string) =>
      setSaved({ ...saved, [agentId]: modelId }),
  };
}
