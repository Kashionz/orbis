// 通知對象的規則（ARCHITECTURE §8、§12.3）。

import type { PermissionPurpose } from "@orbis/protocol";
import { and, eq } from "drizzle-orm";
import { effectiveRole, roleAtLeast } from "../authz/capabilities";
import {
  members,
  projectMemberRoles,
  projects,
  runners,
  type runs,
  type tasks,
} from "../db/schema";
import type { Executor } from "../db/tx";

type RunRow = typeof runs.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

/** 某位 Member 在 Project 的有效 Role；不是這個 Team 的 Member 時回傳 null。 */
async function projectRoleOf(tx: Executor, projectId: string, memberId: string) {
  const [row] = await tx
    .select({ role: members.role, override: projectMemberRoles.role })
    .from(members)
    .innerJoin(projects, eq(projects.teamId, members.teamId))
    .leftJoin(
      projectMemberRoles,
      and(eq(projectMemberRoles.memberId, members.id), eq(projectMemberRoles.projectId, projectId)),
    )
    .where(and(eq(members.id, memberId), eq(projects.id, projectId)));
  return row ? effectiveRole(row.role, row.override) : null;
}

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
    const [project] = await tx.select().from(projects).where(eq(projects.id, task.projectId));
    if (!project) return [];
    const rows = await tx
      .select({ id: members.id, role: members.role, override: projectMemberRoles.role })
      .from(members)
      .leftJoin(
        projectMemberRoles,
        and(
          eq(projectMemberRoles.memberId, members.id),
          eq(projectMemberRoles.projectId, project.id),
        ),
      )
      .where(eq(members.teamId, project.teamId));
    return rows
      .filter((m) => roleAtLeast(effectiveRole(m.role, m.override), "admin"))
      .map((m) => m.id);
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
    const role = await projectRoleOf(tx, task.projectId, requester);
    if (role && roleAtLeast(role, "member")) return [requester];
  }
  return task.assigneeMemberId ? [task.assigneeMemberId] : [];
}
