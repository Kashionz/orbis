// Project、Project 的 Role 覆寫、Repo（ARCHITECTURE §4、§12.2）。管理操作一律 Admin 以上。

import {
  API_ROUTES,
  CreateProjectInput,
  CreateRepoInput,
  GitBranchName,
  GitHubOwnerName,
  GitHubRepoName,
  type ProjectPolicy,
  SetProjectRoleInput,
  UpdateProjectInput,
} from "@orbis/api-contract";
import { and, asc, count, eq, notInArray } from "drizzle-orm";
import { Hono } from "hono";
import { effectiveRole } from "../authz/capabilities";
import {
  actorProjectRoles,
  loadProjectScope,
  requireProjectCapability,
  requireTeamCapability,
} from "../authz/scope";
import { isUniqueViolation } from "../db/errors";
import { members, projectMemberRoles, projects, repos, runs, tasks } from "../db/schema";
import { TERMINAL_RUN_STATUSES } from "../domain/run-status";
import { toProject, toRepo } from "../http/dto";
import { ApiError, conflict, notFound, readId, readJson } from "../http/errors";
import type { AppEnv } from "../http/session";
import type { Services } from "../services";

type ProjectInsert = typeof projects.$inferInsert;

/** App 沒有安裝、也沒有指定時的 default branch。 */
const DEFAULT_BRANCH = "main";

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
  if (policy.autoCreateIssues !== undefined) columns.autoCreateIssues = policy.autoCreateIssues;
  // 每個政策欄位都要在這裡對應：漏掉的欄位會被靜默丟掉，只改它時 set({}) 為空還會拋錯（#82 的 e2e 抓到）。
  if (policy.verificationMaxRetries !== undefined) {
    columns.verificationMaxRetries = policy.verificationMaxRetries;
  }
  if (policy.feedbackBotAllowlist !== undefined) {
    columns.feedbackBotAllowlist = policy.feedbackBotAllowlist;
  }
  return columns;
}

/**
 * Project 的 Role 覆寫清單。契約的 API_ROUTES 只有單筆的 `projectRole`，清單沿用同一個前綴。
 * 之後由契約補上時改用 API_ROUTES。
 */
export const PROJECT_ROLES_PATH = `${API_ROUTES.project}/roles`;

export function createProjectRoutes(s: Services): Hono<AppEnv> {
  const { db, auth } = s;
  const app = new Hono<AppEnv>();

  app.get(API_ROUTES.projects, auth, async (c) => {
    const actor = c.get("actor");
    requireTeamCapability(actor, "view");
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.teamId, actor.teamId))
      .orderBy(asc(projects.createdAt), asc(projects.id));
    const roles = await actorProjectRoles(db, actor);
    return c.json(rows.map((row) => toProject(row, roles(row.id))));
  });

  app.post(API_ROUTES.projects, auth, async (c) => {
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
      // 新的 Project 還沒有任何 Role 覆寫，有效 Role 就是 Team 的 Role。
      return c.json(toProject(project, effectiveRole(actor.teamRole, null)), 201);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(`Task Key 前綴 ${input.keyPrefix} 已被使用`);
      throw error;
    }
  });

  app.get(API_ROUTES.project, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "view");
    return c.json(toProject(scope.project, scope.role));
  });

  app.patch(API_ROUTES.project, auth, async (c) => {
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
    return c.json(toProject(project, scope.role));
  });

  app.delete(API_ROUTES.project, auth, async (c) => {
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

  app.get(PROJECT_ROLES_PATH, auth, async (c) => {
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

  app.put(API_ROUTES.projectRole, auth, async (c) => {
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

  app.delete(API_ROUTES.projectRole, auth, async (c) => {
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

  app.get(API_ROUTES.projectRepos, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "view");
    const rows = await db
      .select()
      .from(repos)
      .where(eq(repos.projectId, scope.project.id))
      .orderBy(asc(repos.createdAt), asc(repos.id));
    return c.json(rows.map((row) => toRepo(row, s.github.installUrl)));
  });

  app.post(API_ROUTES.projectRepos, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "manage_project");
    const input = await readJson(c, CreateRepoInput);
    const registration = await registerRepo(s, input, actor.memberId);
    const [repo] = await db
      .insert(repos)
      .values({ projectId: scope.project.id, ...registration })
      .onConflictDoNothing()
      .returning();
    if (!repo) throw conflict(`${input.owner}/${input.name} 已經登記在這個 Project`);
    return c.json(toRepo(repo, s.github.installUrl), 201);
  });

  app.delete(API_ROUTES.repo, auth, async (c) => {
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

/**
 * 登記 Repo 前向 GitHub 檢查（ARCHITECTURE §11）：
 * - GitHub App 已安裝、而且請求者本人對 repo 有寫入權限：以 GitHub 上的名稱、default branch 與
 *   repo id 為準，並記下 installation（之後由 installation webhook 即時更新）。
 * - 沒有安裝（或 Server 沒有設定 GitHub App）：用輸入值，沒有指定 default branch 就用 `main`。
 */
async function registerRepo(
  s: Services,
  input: { owner: string; name: string; defaultBranch?: string | undefined },
  requesterMemberId: string,
): Promise<{
  githubOwner: string;
  githubName: string;
  defaultBranch: string;
  githubRepoId: number | null;
  githubInstallationId: number | null;
}> {
  const fallback = {
    githubOwner: input.owner,
    githubName: input.name,
    defaultBranch: input.defaultBranch ?? DEFAULT_BRANCH,
    githubRepoId: null,
    githubInstallationId: null,
  };
  if (!s.github.app) return fallback;
  const inspection = await s.github.app.inspectRepo(input.owner, input.name, requesterMemberId);
  if (!inspection.installed) return fallback;
  // GitHub 回傳的值也要符合同樣的格式，才能交給 Runner 用在 git 指令與 Worktree 路徑。
  if (
    !GitHubOwnerName.safeParse(inspection.owner).success ||
    !GitHubRepoName.safeParse(inspection.name).success ||
    !GitBranchName.safeParse(inspection.defaultBranch).success
  ) {
    throw new ApiError(422, "invalid_input", "GitHub 回傳的 Repo 資訊格式不正確");
  }
  return {
    githubOwner: inspection.owner,
    githubName: inspection.name,
    defaultBranch: inspection.defaultBranch,
    githubRepoId: inspection.githubRepoId,
    githubInstallationId: inspection.installationId,
  };
}
