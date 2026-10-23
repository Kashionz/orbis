// 撤銷 Runner（ARCHITECTURE §6.1、§16）：`DELETE /api/runners/:id`、登出、清除過期 session 共用。

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Clock } from "../clock";
import type { Database } from "../db/client";
import { runnerPairingTokens, runners } from "../db/schema";
import type { Dispatcher } from "./dispatcher";
import { CLOSE_REVOKED, type RunnerHub } from "./hub";

export interface RevokeDeps {
  db: Database;
  clock: Clock;
  hub: RunnerHub;
  dispatcher: Dispatcher;
}

/** 撤銷 Runner：不能再以 Runner token 連線、立刻斷線，進行中的 Dispatch 過期並改派。 */
export async function revokeRunner(deps: RevokeDeps, runnerId: string): Promise<void> {
  await deps.db
    .update(runners)
    .set({ revokedAt: deps.clock.now() })
    .where(and(eq(runners.id, runnerId), isNull(runners.revokedAt)));
  deps.hub.disconnect(runnerId, CLOSE_REVOKED, "runner revoked");
  await deps.dispatcher.expireRunnerDispatches(runnerId);
}

/**
 * 撤銷這些 session 配對出的 Local Runner，以及它們建立、還沒使用的 Pairing token。
 * 登出、清除過期 session 時，在刪除 session 之前呼叫（刪除 session 後 `paired_session_id` 與
 * `created_by_session_id` 會被設成 null，就找不到了）。回傳撤銷的 Runner ID。
 */
export async function revokeSessionRunners(
  deps: RevokeDeps,
  sessionIds: readonly string[],
): Promise<string[]> {
  if (sessionIds.length === 0) return [];
  await deps.db
    .update(runnerPairingTokens)
    .set({ revokedAt: deps.clock.now() })
    .where(
      and(
        inArray(runnerPairingTokens.createdBySessionId, [...sessionIds]),
        isNull(runnerPairingTokens.usedAt),
        isNull(runnerPairingTokens.revokedAt),
      ),
    );
  const paired = await deps.db
    .select({ id: runners.id })
    .from(runners)
    .where(
      and(
        inArray(runners.pairedSessionId, [...sessionIds]),
        eq(runners.kind, "local"),
        isNull(runners.revokedAt),
      ),
    );
  for (const { id } of paired) await revokeRunner(deps, id);
  return paired.map((r) => r.id);
}
