// 讀取資源並確認它屬於 Actor 的 Team，同時算出 Actor 在該 Project 中的有效 Role。
// 不屬於這個 Team 的資源一律當作找不到（不透露存在與否）。

import type { Role } from "@orbis/api-contract";
import { and, eq } from "drizzle-orm";
import { projectMemberRoles, projects, runs, tasks } from "../db/schema";
import type { Executor } from "../db/tx";
import { forbidden, notFound } from "../http/errors";
import type { Actor } from "../http/session";
import { authorize, type Capability, effectiveRole } from "./capabilities";

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
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.id, taskId), eq(projects.teamId, actor.teamId)))
    .limit(1);
  if (!row) throw notFound("Task");
  return { ...row, role: await projectRole(db, actor, row.project.id) };
}

export async function loadRunScope(db: Executor, actor: Actor, runId: string): Promise<RunScope> {
  const [row] = await db
    .select({ run: runs, task: tasks, project: projects })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(runs.id, runId), eq(projects.teamId, actor.teamId)))
    .limit(1);
  if (!row) throw notFound("Run");
  return { ...row, role: await projectRole(db, actor, row.project.id) };
}

/** 在 Project 範圍內檢查能力；不允許時丟出 403。 */
export function requireProjectCapability(
  actor: Actor,
  scope: ProjectScope & { task?: TaskRow },
  capability: Capability,
): void {
  const result = authorize(capability, {
    memberId: actor.memberId,
    role: scope.role,
    project: {
      allowMemberTeamRunnerDispatch: scope.project.allowMemberTeamRunnerDispatch,
      forbidSelfApproval: scope.project.forbidSelfApproval,
    },
    task: scope.task ? { assigneeMemberId: scope.task.assigneeMemberId } : undefined,
  });
  if (!result.ok) throw forbidden(result.reason);
}

/** 在 Team 範圍內檢查能力（管理成員、Team Runner、Project 列表等）。 */
export function requireTeamCapability(actor: Actor, capability: Capability): void {
  const result = authorize(capability, { memberId: actor.memberId, role: actor.teamRole });
  if (!result.ok) throw forbidden(result.reason);
}
