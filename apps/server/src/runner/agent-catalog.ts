// 模型目錄（後端缺口 `model-catalog`）：彙整目前 Member 可用的 Runner（自己的 Local Runner，以及 Member 以上
// 可以派工的 Team Runner）回報的 AgentAvailability。同一個 Agent 在多台 Runner 上時合併成一筆。

import type { AgentCatalogEntry, AgentCatalogResponse, CatalogModel } from "@orbis/api-contract";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { roleAtLeast } from "../authz/capabilities";
import { agentAvailabilities, runners } from "../db/schema";
import type { Executor } from "../db/tx";
import type { Actor } from "../http/session";
import type { AvailabilityDetails } from "./dispatch-options";

/** 目前 Member 可用的 Runner：自己的 Local Runner；Member 以上再加上 Team Runner。 */
export async function usableRunnerIds(db: Executor, actor: Actor): Promise<string[]> {
  const rows = await db
    .select({ id: runners.id })
    .from(runners)
    .where(
      and(
        eq(runners.teamId, actor.teamId),
        isNull(runners.revokedAt),
        roleAtLeast(actor.teamRole, "member")
          ? or(eq(runners.kind, "team"), eq(runners.memberId, actor.memberId))
          : and(eq(runners.kind, "local"), eq(runners.memberId, actor.memberId)),
      ),
    );
  return rows.map((r) => r.id);
}

export async function agentCatalog(db: Executor, actor: Actor): Promise<AgentCatalogResponse> {
  const runnerIds = await usableRunnerIds(db, actor);
  if (runnerIds.length === 0) return [];
  const rows = await db
    .select()
    .from(agentAvailabilities)
    .where(inArray(agentAvailabilities.runnerId, runnerIds));
  return mergeCatalog(
    rows.map((row) => ({ agent: row.agent, details: (row.details ?? {}) as AvailabilityDetails })),
  );
}

/**
 * 合併各 Runner 的回報：model 依 id 聯集（`session` 來源優先於 `profile`）；任何一台已登入就是已登入，
 * 全部無法得知時為 null；登入方式取第一個有的。依 Agent id 排序。
 */
export function mergeCatalog(
  rows: { agent: string; details: AvailabilityDetails }[],
): AgentCatalogResponse {
  const byAgent = new Map<
    string,
    { entry: AgentCatalogEntry; models: Map<string, CatalogModel>; signedIn: (boolean | null)[] }
  >();
  for (const { agent, details } of rows) {
    const catalog = details.catalog;
    const current = byAgent.get(agent) ?? {
      entry: {
        agentId: agent,
        tool: catalog?.displayName ?? agent,
        vendor: catalog?.vendor ?? null,
        cliId: catalog?.cli ?? null,
        models: [],
        signedIn: null,
        loginHint: catalog?.loginHint ?? null,
      },
      models: new Map<string, CatalogModel>(),
      signedIn: [],
    };
    if (catalog) {
      current.entry.vendor ??= catalog.vendor;
      current.entry.cliId ??= catalog.cli;
      current.entry.loginHint ??= catalog.loginHint;
      current.signedIn.push(catalog.signedIn);
      for (const model of catalog.models) {
        const existing = current.models.get(model.id);
        if (!existing || (existing.source === "profile" && model.source === "session")) {
          current.models.set(model.id, {
            id: model.id,
            name: model.name,
            tag: model.tag,
            effort: model.effort,
            source: model.source,
          });
        }
      }
    }
    byAgent.set(agent, current);
  }
  return [...byAgent.values()]
    .map(({ entry, models, signedIn }) => ({
      ...entry,
      models: [...models.values()],
      signedIn: signedIn.includes(true) ? true : signedIn.includes(false) ? false : null,
    }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}
