// 派工對話框的選項（契約的 DispatchOptions，ARCHITECTURE §6.1、§8）：把各 Runner 回報的
// AgentAvailability 依 Runner 種類彙整成「這種 Runner 目前能跑哪些 Agent」。

import type { AgentOption, DispatchTarget } from "@orbis/api-contract";
import type { LoginHint, ModelInfo } from "@orbis/protocol";
import type { agentAvailabilities } from "../db/schema";

type AvailabilityRow = typeof agentAvailabilities.$inferSelect;

/** 模型目錄需要的 AgentInfo 欄位（協定版本 3）。 */
export interface AgentCatalogDetails {
  displayName: string;
  vendor: string | null;
  cli: string | null;
  signedIn: boolean | null;
  loginHint: LoginHint | null;
  models: ModelInfo[];
}

/** recordAgentAvailability 存進 details 的欄位。協定版本 3 之前存的列沒有 catalog 與 mappedRepos。 */
export interface AvailabilityDetails {
  version?: string | null;
  unavailableReason?: string | null;
  models?: string[];
  permissionGaps?: string[];
  catalog?: AgentCatalogDetails;
  mappedRepos?: string[];
}

export interface RunnerAvailability {
  /** 在線而且接受新的 Dispatch（Heartbeat 的 accepting_dispatches）。 */
  dispatchable: boolean;
  agents: AvailabilityRow[];
}

/**
 * 彙整同一種 Runner 的 AgentAvailability。
 * - Agent 只要在任一台 Runner 上可用就算可用；版本取自第一台可用的 Runner。
 * - models 與 permissionGaps 取所有回報的聯集（排序），讓對話框列出所有選擇與警告。
 * - 離線或暫停領取的 Runner 沿用它最後回報的可用性：ARCHITECTURE §6.1 允許派工給離線的 Runner，
 *   Run 停在佇列等它上線；是否在線由 `online` 另外表達，對話框據此提示 Run 會排隊。
 */
export function summarizeDispatchTarget(runners: RunnerAvailability[]): DispatchTarget {
  const byAgent = new Map<
    string,
    {
      available: AgentOption | null;
      fallback: AgentOption;
      models: Set<string>;
      gaps: Set<string>;
    }
  >();
  for (const runner of runners) {
    for (const row of runner.agents) {
      const details = (row.details ?? {}) as AvailabilityDetails;
      const option: AgentOption = {
        id: row.agent,
        version: details.version ?? null,
        available: row.available,
        unavailableReason: row.available
          ? null
          : (details.unavailableReason ?? "Agent 目前無法使用"),
        models: [],
        permissionGaps: [],
      };
      const entry = byAgent.get(row.agent) ?? {
        available: null,
        fallback: option,
        models: new Set<string>(),
        gaps: new Set<string>(),
      };
      if (option.available && entry.available === null) entry.available = option;
      for (const model of details.models ?? []) if (model !== "") entry.models.add(model);
      for (const gap of details.permissionGaps ?? []) entry.gaps.add(gap);
      byAgent.set(row.agent, entry);
    }
  }
  const agents = [...byAgent.values()]
    .map(
      (entry): AgentOption => ({
        ...(entry.available ?? entry.fallback),
        models: [...entry.models].sort(),
        permissionGaps: [...entry.gaps].sort(),
      }),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  // TODO(backend, local-repo)：依 Task 的本機 Repo 與 Runner 的 mapped_repos 判斷 repo_not_mapped。
  return { online: runners.some((r) => r.dispatchable), agents, unavailableReason: null };
}
