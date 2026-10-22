// Project、Project 的 Role 覆寫、Repo（ARCHITECTURE §4、§12.2）。管理操作一律 Admin 以上。

import { and, asc, count, eq, notInArray } from "drizzle-orm";
import { Hono } from "hono";
import { loadProjectScope, requireProjectCapability, requireTeamCapability } from "../authz/scope";
import {
  CreateProjectInput,
  CreateRepoInput,
  type ProjectPolicy,
  SetProjectRoleInput,
  UpdateProjectInput,
} from "../contract-pending";
import { members, projectMemberRoles, projects, repos, runs, tasks } from "../db/schema";
import { TERMINAL_RUN_STATUSES } from "../domain/run-status";
import { RepoRegistrationError } from "../github/integration";
import { toProject, toRepo } from "../http/dto";
import { ApiError, conflict, notFound, readId, readJson } from "../http/errors";
import type { AppEnv } from "../http/session";
import type { Services } from "../services";

type ProjectInsert = typeof projects.$inferInsert;

/** API 的 ProjectPolicy 欄位對應到資料表欄位。 */
function policyColumns(policy: Partial<ProjectPolicy>): Partial<ProjectInsert> {
  const columns: Partial<ProjectInsert> = {};
  if (policy.planGateEnabled !== undefined) columns.planGateEnabled = policy.planGateEnabled;
  if (policy.delegationEnabled !== undefined) columns.delegationEnabled = policy.delegationEnabled;
  if (policy.delegationAgents !== undefined) {
    columns.delegationAllowedAgents = policy.delegationAgents;
  }
  if (policy.forbidSelfApproval !== undefined) {
    columns.forbidSelfApproval = policy.forbidSelfApproval;
  }
  if (policy.memberCanDispatchToTeamRunner !== undefined) {
    columns.allowMemberTeamRunnerDispatch = policy.memberCanDispatchToTeamRunner;
  }
  if (policy.defaultPermissionPolicy !== undefined) {
    columns.defaultPermissionPolicy = policy.defaultPermissionPolicy;
  }
  return columns;
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } }).cause;
  return (error as { code?: string }).code === "23505" || cause?.code === "23505";
}

export function createProjectRoutes(s: Services): Hono<AppEnv> {
  const { db, auth } = s;
  const app = new Hono<AppEnv>();

  app.get("/projects", auth, async (c) => {
    const actor = c.get("actor");
    requireTeamCapability(actor, "view");
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.teamId, actor.teamId))
      .orderBy(asc(projects.createdAt), asc(projects.id));
    return c.json(rows.map(toProject));
  });

  app.post("/projects", auth, async (c) => {
    const actor = c.get("actor");
    requireTeamCapability(actor, "manage_project");
    const input = await readJson(c, CreateProjectInput);
    try {
      const [project] = await db
        .insert(projects)
        .values({
          teamId: actor.teamId,
          name: input.name,
          description: input.description,
          taskKeyPrefix: input.keyPrefix,
          ...policyColumns(input.policy),
        })
        .returning();
      if (!project) throw new Error("建立 Project 失敗");
      return c.json(toProject(project), 201);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(`Task Key 前綴 ${input.keyPrefix} 已被使用`);
      throw error;
    }
  });

  app.get("/projects/:projectId", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "view");
    return c.json(toProject(scope.project));
  });

  app.patch("/projects/:projectId", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "manage_project");
    const input = await readJson(c, UpdateProjectInput);
    if (input.policy?.defaultPermissionPolicy !== undefined) {
      requireProjectCapability(actor, scope, "manage_permission_policy");
    }
    const [project] = await db
      .update(projects)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...policyColumns(input.policy ?? {}),
      })
      .where(eq(projects.id, scope.project.id))
      .returning();
    if (!project) throw notFound("Project");
    return c.json(toProject(project));
  });

  app.delete("/projects/:projectId", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "manage_project");
    const [active] = await db
      .select({ n: count() })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(
        and(eq(tasks.projectId, scope.project.id), notInArray(runs.status, TERMINAL_RUN_STATUSES)),
      );
    if ((active?.n ?? 0) > 0) throw conflict("Project 中還有進行中的 Run，請先中止");
    await db.delete(projects).where(eq(projects.id, scope.project.id));
    return c.body(null, 204);
  });

  // ---- Role 覆寫 ----

  app.get("/projects/:projectId/roles", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "view");
    const rows = await db
      .select({
        projectId: projectMemberRoles.projectId,
        memberId: projectMemberRoles.memberId,
        role: projectMemberRoles.role,
      })
      .from(projectMemberRoles)
      .where(eq(projectMemberRoles.projectId, scope.project.id))
      .orderBy(asc(projectMemberRoles.createdAt));
    return c.json(rows);
  });

  app.put("/projects/:projectId/roles/:memberId", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "manage_project");
    const memberId = readId(c, "memberId", "Member");
    const input = await readJson(c, SetProjectRoleInput);
    const [member] = await db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.id, memberId), eq(members.teamId, actor.teamId)));
    if (!member) throw notFound("Member");
    if (member.role === "owner") throw conflict("Team 的 Owner 不能被 Project 覆寫 Role");
    await db
      .insert(projectMemberRoles)
      .values({ projectId: scope.project.id, memberId, role: input.role })
      .onConflictDoUpdate({
        target: [projectMemberRoles.projectId, projectMemberRoles.memberId],
        set: { role: input.role },
      });
    return c.json({ projectId: scope.project.id, memberId, role: input.role });
  });

  app.delete("/projects/:projectId/roles/:memberId", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "manage_project");
    const memberId = readId(c, "memberId", "Member");
    await db
      .delete(projectMemberRoles)
      .where(
        and(
          eq(projectMemberRoles.projectId, scope.project.id),
          eq(projectMemberRoles.memberId, memberId),
        ),
      );
    return c.body(null, 204);
  });

  // ---- Repo ----

  app.get("/projects/:projectId/repos", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "view");
    const rows = await db
      .select()
      .from(repos)
      .where(eq(repos.projectId, scope.project.id))
      .orderBy(asc(repos.createdAt), asc(repos.id));
    return c.json(rows.map(toRepo));
  });

  app.post("/projects/:projectId/repos", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "manage_project");
    const input = await readJson(c, CreateRepoInput);
    let registration: Awaited<ReturnType<typeof s.github.repoRegistrar.register>>;
    try {
      registration = await s.github.repoRegistrar.register(input);
    } catch (error) {
      if (error instanceof RepoRegistrationError) {
        throw new ApiError(422, "invalid_input", error.message);
      }
      throw error;
    }
    const [repo] = await db
      .insert(repos)
      .values({
        projectId: scope.project.id,
        githubOwner: registration.owner,
        githubName: registration.name,
        defaultBranch: registration.defaultBranch,
        githubRepoId: registration.githubRepoId,
      })
      .onConflictDoNothing()
      .returning();
    if (!repo) throw conflict(`${input.owner}/${input.name} 已經登記在這個 Project`);
    return c.json(toRepo(repo), 201);
  });

  app.delete("/repos/:repoId", auth, async (c) => {
    const actor = c.get("actor");
    const repoId = readId(c, "repoId", "Repo");
    const [repo] = await db.select().from(repos).where(eq(repos.id, repoId));
    if (!repo) throw notFound("Repo");
    const scope = await loadProjectScope(db, actor, repo.projectId);
    requireProjectCapability(actor, scope, "manage_project");
    const [used] = await db.select({ n: count() }).from(tasks).where(eq(tasks.repoId, repoId));
    if ((used?.n ?? 0) > 0) throw conflict("還有 Task 使用這個 Repo，不能移除");
    await db.delete(repos).where(eq(repos.id, repoId));
    return c.body(null, 204);
  });

  return app;
}
