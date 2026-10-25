// 讀取資源並確認它屬於 Actor 的 Team，同時算出 Actor 在該 Project 中的有效 Role。
// 不屬於這個 Team 的資源一律當作找不到（不透露存在與否）。

import type { Role, TaskAccess, TaskShareRole } from "@orbis/api-contract";
import { and, eq, ne, or, type SQL, sql } from "drizzle-orm";
import { projectMemberRoles, projects, runs, taskMembers, tasks } from "../db/schema";
import type { Executor } from "../db/tx";
import type { TaskViewer } from "../http/dto";
import { forbidden, notFound } from "../http/errors";
import type { Actor } from "../http/session";
import {
  authorize,
  type Capability,
  effectiveRole,
  roleAtLeast,
  roleOnTask,
  TASK_CAPABILITIES,
  taskAccess,
} from "./capabilities";

export type ProjectRow = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type RunRow = typeof runs.$inferSelect;

export interface ProjectScope {
  project: ProjectRow;
  /** Actor 在這個 Project 中的有效 Role。 */
  role: Role;
}

export interface TaskScope extends ProjectScope {
  task: TaskRow;
  /** Actor 在這個 Task 上的有效權限（ADR-0012）。 */
  access: TaskAccess;
  /** 判斷 Task 能力（TASK_CAPABILITIES）時用的 Role：Task 角色與一般存取換算後的結果。 */
  taskRole: Role;
}

export interface RunScope extends TaskScope {
  run: RunRow;
}

async function projectRole(db: Executor, actor: Actor, projectId: string): Promise<Role> {
  if (actor.teamRole === "owner") return "owner";
  const [override] = await db
    .select({ role: projectMemberRoles.role })
    .from(projectMemberRoles)
    .where(
      and(
        eq(projectMemberRoles.projectId, projectId),
        eq(projectMemberRoles.memberId, actor.memberId),
      ),
    )
    .limit(1);
  return effectiveRole(actor.teamRole, override?.role);
}

export async function loadProjectScope(
  db: Executor,
  actor: Actor,
  projectId: string,
): Promise<ProjectScope> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.teamId, actor.teamId)))
    .limit(1);
  if (!project) throw notFound("Project");
  return { project, role: await projectRole(db, actor, project.id) };
}

export async function loadTaskScope(
  db: Executor,
  actor: Actor,
  taskId: string,
): Promise<TaskScope> {
  const [row] = await db
    .select({ task: tasks, project: projects, shareRole: taskMembers.role })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(
      taskMembers,
      and(eq(taskMembers.taskId, tasks.id), eq(taskMembers.memberId, actor.memberId)),
    )
    .where(and(eq(tasks.id, taskId), eq(projects.teamId, actor.teamId)))
    .limit(1);
  if (!row) throw notFound("Task");
  const role = await projectRole(db, actor, row.project.id);
  const scope = withTaskAccess(row.task, row.project, role, row.shareRole);
  if (!scope) throw notFound("Task");
  return scope;
}

export async function loadRunScope(db: Executor, actor: Actor, runId: string): Promise<RunScope> {
  const [row] = await db
    .select({ run: runs, task: tasks, project: projects, shareRole: taskMembers.role })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(
      taskMembers,
      and(eq(taskMembers.taskId, tasks.id), eq(taskMembers.memberId, actor.memberId)),
    )
    .where(and(eq(runs.id, runId), eq(projects.teamId, actor.teamId)))
    .limit(1);
  if (!row) throw notFound("Run");
  const role = await projectRole(db, actor, row.project.id);
  const scope = withTaskAccess(row.task, row.project, role, row.shareRole);
  if (!scope) throw notFound("Run");
  return { ...scope, run: row.run };
}

/** 算出 Task 上的有效權限；看不到時回 null（呼叫端一律當作找不到，不透露存在與否）。 */
function withTaskAccess(
  task: TaskRow,
  project: ProjectRow,
  role: Role,
  shareRole: TaskShareRole | null,
): TaskScope | null {
  const access = taskAccess({ role, taskRole: shareRole, generalAccess: task.generalAccess });
  if (access === null) return null;
  return { task, project, role, access, taskRole: roleOnTask(role, access) };
}

/**
 * 列表用的條件：Actor 看得到的 Task（ADR-0012）。在 Project 中是 Admin 以上時不過濾（回 undefined）；
 * 否則一般存取不是 `invited`，或 Actor 是 Task 成員。
 */
export function visibleTasksCondition(memberId: string, role: Role): SQL | undefined {
  if (roleAtLeast(role, "admin")) return undefined;
  return or(
    ne(tasks.generalAccess, "invited"),
    sql`exists (select 1 from ${taskMembers} where ${taskMembers.taskId} = ${tasks.id} and ${taskMembers.memberId} = ${memberId})`,
  );
}

/**
 * Actor 在各 Project 的有效 Role：一次查出 Actor 所有的 Project 覆寫，列表不必逐一查詢。
 */
export async function actorProjectRoles(
  db: Executor,
  actor: Actor,
): Promise<(projectId: string) => Role> {
  if (actor.teamRole === "owner") return () => "owner";
  const overrides = await db
    .select({ projectId: projectMemberRoles.projectId, role: projectMemberRoles.role })
    .from(projectMemberRoles)
    .where(eq(projectMemberRoles.memberId, actor.memberId));
  const byProject = new Map(overrides.map((o) => [o.projectId, o.role]));
  return (projectId) => effectiveRole(actor.teamRole, byProject.get(projectId));
}

/**
 * 在 Project 範圍內檢查能力；不允許時丟出 403。scope 是 Task 或 Run 時，Task 的能力（TASK_CAPABILITIES）
 * 用 Task 上的 Role 判斷（ADR-0012），Admin 層級的能力仍用 Project 的 Role。
 */
export function requireProjectCapability(
  actor: Actor,
  scope: ProjectScope & { task?: TaskRow; taskRole?: Role },
  capability: Capability,
  /** 核准 Gate 時，Gate 建立當時的指派對象。 */
  gateAssigneeMemberId?: string | null,
): void {
  const role =
    scope.taskRole !== undefined && TASK_CAPABILITIES.includes(capability)
      ? scope.taskRole
      : scope.role;
  const result = authorize(capability, {
    memberId: actor.memberId,
    role,
    project: {
      allowMemberTeamRunnerDispatch: scope.project.allowMemberTeamRunnerDispatch,
      forbidSelfApproval: scope.project.forbidSelfApproval,
    },
    task: scope.task
      ? { assigneeMemberId: scope.task.assigneeMemberId, gateAssigneeMemberId }
      : undefined,
  });
  if (!result.ok) throw forbidden(result.reason);
}

/** 在 Team 範圍內檢查能力（管理成員、Team Runner、Project 列表等）。 */
export function requireTeamCapability(actor: Actor, capability: Capability): void {
  const result = authorize(capability, { memberId: actor.memberId, role: actor.teamRole });
  if (!result.ok) throw forbidden(result.reason);
}

/** 單一 Project 中看 Task 的人（`toTasks` 算 `viewerAccess` 用）。 */
export function taskViewer(actor: Actor, scope: ProjectScope): TaskViewer {
  return { memberId: actor.memberId, projectRole: () => scope.role };
}
