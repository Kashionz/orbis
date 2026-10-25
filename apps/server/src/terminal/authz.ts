// 誰能開互動式終端機（ADR-0014）：Local Runner 只限那台 Runner 的擁有者；Team Runner 只限 Admin 以上，
// 而且 Team 設定打開。開啟時與連線期間定期重新確認都用這裡的判斷。

import { eq } from "drizzle-orm";
import { roleAtLeast } from "../authz/capabilities";
import { loadRunScope, type RunScope } from "../authz/scope";
import { runners, teams } from "../db/schema";
import type { Executor } from "../db/tx";
import { ApiError, forbidden } from "../http/errors";
import type { Actor } from "../http/session";
import { currentDispatch } from "../runs/run-control";

export interface TerminalAccess {
  scope: RunScope;
  runner: typeof runners.$inferSelect;
}

/** 能不能在這個 Run 的 Worktree 開終端機；不行時丟出對應的 ApiError。 */
export async function authorizeTerminal(
  db: Executor,
  actor: Actor,
  runId: string,
): Promise<TerminalAccess> {
  const scope = await loadRunScope(db, actor, runId);
  const dispatch = await currentDispatch(db, scope.run.id);
  const [runner] = dispatch
    ? await db.select().from(runners).where(eq(runners.id, dispatch.runnerId))
    : [];
  if (!dispatch || !runner || runner.revokedAt) {
    throw new ApiError(409, "runner_offline", "這個 Run 沒有可以開終端機的 Runner");
  }
  if (runner.kind === "local") {
    if (runner.memberId !== actor.memberId) {
      throw forbidden("只有這台 Local Runner 的擁有者能開終端機");
    }
    return { scope, runner };
  }
  if (!roleAtLeast(scope.role, "admin")) {
    throw forbidden("Team Runner 的終端機只限 Admin 以上");
  }
  const [team] = await db
    .select({ allowed: teams.allowTeamRunnerTerminal })
    .from(teams)
    .where(eq(teams.id, actor.teamId));
  if (!team?.allowed) {
    throw new ApiError(403, "terminal_disabled", "Team 設定沒有打開 Team Runner 的終端機");
  }
  return { scope, runner };
}
