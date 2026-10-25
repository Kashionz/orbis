// 通知對象的規則（ARCHITECTURE §8、§12.3）。

import type { PermissionPurpose } from "@orbis/protocol";
import { eq } from "drizzle-orm";
import { roleAtLeast } from "../authz/capabilities";
import { memberOnTask, membersOnTask } from "../authz/task-access";
import { runners, type runs, type tasks } from "../db/schema";
import type { Executor } from "../db/tx";

type RunRow = typeof runs.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

/**
 * 權限請求通知誰：
 * - 設定的信任核准（`config_trust`）：Project 中 Admin 以上的人。
 * - Local Runner 上的 Run：Runner 的擁有者（只有他能回覆）。
 * - Team Runner 上的 Run：派工者；派工者無權回覆時給 Task 負責人。
 */
export async function permissionRequestRecipients(
  tx: Executor,
  run: RunRow,
  task: TaskRow,
  purpose: PermissionPurpose,
): Promise<string[]> {
  if (purpose === "config_trust") {
    // Admin 以上永遠看得到 Task（ADR-0012），所以不必另外過濾。
    const onTask = await membersOnTask(tx, task.id);
    return onTask.filter((m) => roleAtLeast(m.projectRole, "admin")).map((m) => m.memberId);
  }
  if (run.target === "local") {
    const [runner] = run.runnerId
      ? await tx
          .select({ memberId: runners.memberId })
          .from(runners)
          .where(eq(runners.id, run.runnerId))
      : [];
    const owner = runner?.memberId ?? run.requestedByMemberId;
    return owner ? [owner] : [];
  }
  const requester = run.requestedByMemberId;
  if (requester) {
    const onTask = await memberOnTask(tx, task.id, requester);
    if (onTask && roleAtLeast(onTask.taskRole, "member")) return [requester];
  }
  return task.assigneeMemberId ? [task.assigneeMemberId] : [];
}
