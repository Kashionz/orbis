// Local Runner 的擁有者（ARCHITECTURE §8、§12.2）：Local Runner 跑在某個人自己的電腦上、用那個人的 Credential，
// 回覆它的權限請求、換它的 Permission Policy、在它上面換 Agent 都只限那個人。

import type { PermissionPurpose } from "@orbis/protocol";
import { eq } from "drizzle-orm";
import { runners } from "../db/schema";
import type { Executor } from "../db/tx";
import { forbidden } from "../http/errors";
import type { Actor } from "../http/session";
import { authorizePermissionResponse } from "./capabilities";
import type { RunScope } from "./scope";

/** Run 所在 Local Runner 的擁有者；Team Runner 為 null。Runner 已刪除時以派工的人代替。 */
export function runnerOwnerOf(
  run: { target: "local" | "team"; requestedByMemberId: string | null },
  runnerMemberId: string | null | undefined,
): string | null {
  if (run.target !== "local") return null;
  return runnerMemberId ?? run.requestedByMemberId;
}

async function ownerOfRun(db: Executor, scope: RunScope): Promise<string | null> {
  const [runner] = scope.run.runnerId
    ? await db
        .select({ memberId: runners.memberId })
        .from(runners)
        .where(eq(runners.id, scope.run.runnerId))
    : [];
  return runnerOwnerOf(scope.run, runner?.memberId);
}

/** 確認 Actor 可以回覆這個 Run 的權限請求；不行時丟出 403。 */
export async function requirePermissionResponder(
  db: Executor,
  actor: Actor,
  scope: RunScope,
  purpose: PermissionPurpose,
): Promise<void> {
  const result = authorizePermissionResponse({
    memberId: actor.memberId,
    // Task 上的 Role（ADR-0012）：被分享為可操作的人可以回覆；config 信任仍只有 Admin 以上。
    role: scope.taskRole,
    runnerKind: scope.run.target,
    runnerOwnerMemberId: await ownerOfRun(db, scope),
    purpose,
  });
  if (!result.ok) throw forbidden(result.reason);
}

/** Run 在 Local Runner 上時，只有那台 Runner 的擁有者能做 `what`；Team Runner 不檢查。 */
export async function requireLocalRunnerOwner(
  db: Executor,
  actor: Actor,
  scope: RunScope,
  what: string,
): Promise<void> {
  if (scope.run.target !== "local") return;
  if ((await ownerOfRun(db, scope)) !== actor.memberId) {
    throw forbidden(`只有這台 Local Runner 的擁有者能${what}`);
  }
}
