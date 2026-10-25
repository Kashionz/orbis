// Task 分享（ADR-0012）在列表與收件人上的套用：一次算出多個 Task 或多位 Member 的有效權限。
// 單一 Task 的 API 由 scope.ts 的 loadTaskScope／loadRunScope 處理。

import type { Role, TaskAccess } from "@orbis/api-contract";
import { and, eq, inArray } from "drizzle-orm";
import { members, projectMemberRoles, projects, taskMembers, tasks } from "../db/schema";
import type { Executor } from "../db/tx";
import type { Actor } from "../http/session";
import { effectiveRole, roleOnTask, taskAccess } from "./capabilities";
import { actorProjectRoles } from "./scope";

/** 一批 Task 中 Actor 看得到的 Task id（可以跨 Project）。 */
export async function visibleTaskIds(
  db: Executor,
  actor: Actor,
  taskIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return new Set();
  const roleIn = await actorProjectRoles(db, actor);
  const rows = await db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      generalAccess: tasks.generalAccess,
      shareRole: taskMembers.role,
    })
    .from(tasks)
    .leftJoin(
      taskMembers,
      and(eq(taskMembers.taskId, tasks.id), eq(taskMembers.memberId, actor.memberId)),
    )
    .where(inArray(tasks.id, ids));
  return new Set(
    rows
      .filter(
        (row) =>
          taskAccess({
            role: roleIn(row.projectId),
            taskRole: row.shareRole,
            generalAccess: row.generalAccess,
          }) !== null,
      )
      .map((row) => row.id),
  );
}

export interface MemberOnTask {
  memberId: string;
  /** 在 Task 所屬 Project 的有效 Role。 */
  projectRole: Role;
  access: TaskAccess;
  /** 判斷 Task 能力時用的 Role（capabilities.ts 的 roleOnTask）。 */
  taskRole: Role;
}

/**
 * Team 中每位 Member 在某個 Task 上的有效權限；看不到這個 Task 的人不在結果中。
 * 通知與 Gate 的收件人用（只通知看得到 Task 的人）。
 */
export async function membersOnTask(db: Executor, taskId: string): Promise<MemberOnTask[]> {
  const [context] = await db
    .select({ projectId: tasks.projectId, teamId: projects.teamId, access: tasks.generalAccess })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId));
  if (!context) return [];
  const rows = await db
    .select({
      id: members.id,
      role: members.role,
      override: projectMemberRoles.role,
      shareRole: taskMembers.role,
    })
    .from(members)
    .leftJoin(
      projectMemberRoles,
      and(
        eq(projectMemberRoles.memberId, members.id),
        eq(projectMemberRoles.projectId, context.projectId),
      ),
    )
    .leftJoin(
      taskMembers,
      and(eq(taskMembers.memberId, members.id), eq(taskMembers.taskId, taskId)),
    )
    .where(eq(members.teamId, context.teamId));
  return rows.flatMap((row) => {
    const projectRole = effectiveRole(row.role, row.override);
    const access = taskAccess({
      role: projectRole,
      taskRole: row.shareRole,
      generalAccess: context.access,
    });
    if (access === null) return [];
    return [{ memberId: row.id, projectRole, access, taskRole: roleOnTask(projectRole, access) }];
  });
}

/** 某位 Member 在某個 Task 上的有效權限；不是這個 Team 的 Member 或看不到時為 null。 */
export async function memberOnTask(
  db: Executor,
  taskId: string,
  memberId: string,
): Promise<MemberOnTask | null> {
  const all = await membersOnTask(db, taskId);
  return all.find((m) => m.memberId === memberId) ?? null;
}
