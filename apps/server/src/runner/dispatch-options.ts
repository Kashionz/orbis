// 派工對話框的選項（契約的 DispatchOptions，ARCHITECTURE §6.1、§8）：把各 Runner 回報的
// AgentAvailability 依 Runner 種類彙整成「這種 Runner 目前能跑哪些 Agent」。

import type { AgentOption, DispatchTarget } from "@orbis/api-contract";
import type { agentAvailabilities } from "../db/schema";

type AvailabilityRow = typeof agentAvailabilities.$inferSelect;

/** recordAgentAvailability 存進 details 的欄位。 */
interface AvailabilityDetails {
  version?: string | null;
  unavailableReason?: string | null;
  models?: string[];
  permissionGaps?: string[];
}

export interface RunnerAvailability {
  /** 在線而且接受新的 Dispatch（Heartbeat 的 accepting_dispatches）。 */
  dispatchable: boolean;
  agents: AvailabilityRow[];
}

/** 沒有任何一台可派工的 Runner 時，Agent 的不可用原因。 */
export const NO_DISPATCHABLE_RUNNER = "沒有在線而且接受派工的 Runner";

/**
 * 彙整同一種 Runner 的 AgentAvailability。
 * - Agent 只要在任一台可派工的 Runner 上可用就算可用；版本取自第一台可用的 Runner。
 * - models 與 permissionGaps 取所有回報的聯集（排序），讓對話框列出所有選擇與警告。
 * - 離線或暫停領取的 Runner 也列出它最後回報的 Agent，但一律不可用。
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
        available: runner.dispatchable && row.available,
        unavailableReason: null,
        models: [],
        permissionGaps: [],
      };
      if (!option.available) {
        option.unavailableReason = !runner.dispatchable
          ? NO_DISPATCHABLE_RUNNER
          : (details.unavailableReason ?? "Agent 目前無法使用");
      }
      const entry = byAgent.get(row.agent) ?? {
        available: null,
        fallback: option,
        models: new Set<string>(),
        gaps: new Set<string>(),
      };
      if (option.available && entry.available === null) entry.available = option;
      // 不可用時，優先顯示 Runner 在線時回報的具體原因。
      if (
        !option.available &&
        runner.dispatchable &&
        entry.fallback.unavailableReason === NO_DISPATCHABLE_RUNNER
      ) {
        entry.fallback = option;
      }
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
  return { online: runners.some((r) => r.dispatchable), agents };
}
