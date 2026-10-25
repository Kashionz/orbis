// Repo Spec 與 Repo 的 GitHub 狀態（ARCHITECTURE §11、§12.1）。
//
// - Repo Spec：登記 Repo 內的 markdown Spec 檔；草稿在共同編輯文件 `repo-spec-draft:<id>`，「提交到 repo」
//   時 Server 取出草稿的 markdown，交給 GitHub 整合開分支、commit 並開 PR（packages/github 的 commitRepoSpec）。
// - 重新檢查 Repo 的 GitHub App 安裝狀態（Repo 設定頁），權限與登記 Repo 相同（Admin 以上）。

import {
  API_ROUTES,
  CreateRepoSpecInput,
  type RepoSpec,
  RepoSpecCommitInput,
  type RepoSpecCommitResponse,
} from "@orbis/api-contract";
import { coAuthor, isCommittableSpecPath } from "@orbis/github";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { loadProjectScope, requireProjectCapability } from "../authz/scope";
import { collabDocRef } from "../collab/doc-name";
import {
  agentAvailabilities,
  members,
  repoSpecPullRequests,
  repoSpecs,
  repos,
  runners,
} from "../db/schema";
import type { Executor } from "../db/tx";
import { toRepo } from "../http/dto";
import { ApiError, conflict, notFound, readId, readJson } from "../http/errors";
import type { Actor, AppEnv } from "../http/session";
import { mapsRepo } from "../runner/dispatcher";
import type { Services } from "../services";

type SpecRow = typeof repoSpecs.$inferSelect;

async function toRepoSpecs(db: Executor, rows: SpecRow[]): Promise<RepoSpec[]> {
  const open =
    rows.length > 0
      ? await db
          .select()
          .from(repoSpecPullRequests)
          .where(
            and(
              inArray(
                repoSpecPullRequests.repoSpecId,
                rows.map((r) => r.id),
              ),
              eq(repoSpecPullRequests.state, "open"),
            ),
          )
      : [];
  return rows.map((row) => {
    const pr = open.find((p) => p.repoSpecId === row.id);
    return {
      id: row.id,
      repoId: row.repoId,
      path: row.path,
      title: row.title,
      version: row.version,
      committedSha: row.committedSha,
      openPullRequest: pr ? { number: pr.number, url: pr.url } : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

export function createRepoSpecRoutes(s: Services): Hono<AppEnv> {
  const { db, auth } = s;
  const app = new Hono<AppEnv>();

  const loadRepo = async (actor: Actor, repoId: string) => {
    const [repo] = await db.select().from(repos).where(eq(repos.id, repoId));
    if (!repo) throw notFound("Repo");
    return { repo, scope: await loadProjectScope(db, actor, repo.projectId) };
  };

  const loadSpec = async (actor: Actor, repoSpecId: string) => {
    const [spec] = await db.select().from(repoSpecs).where(eq(repoSpecs.id, repoSpecId));
    if (!spec) throw notFound("Repo Spec");
    return { spec, ...(await loadRepo(actor, spec.repoId)) };
  };

  app.get(API_ROUTES.repoSpecs, auth, async (c) => {
    const actor = c.get("actor");
    const { repo, scope } = await loadRepo(actor, readId(c, "repoId", "Repo"));
    requireProjectCapability(actor, scope, "view");
    const rows = await db
      .select()
      .from(repoSpecs)
      .where(eq(repoSpecs.repoId, repo.id))
      .orderBy(asc(repoSpecs.path));
    return c.json(await toRepoSpecs(db, rows));
  });

  /** 登記一個 Repo Spec（檔案還不存在時，提交後才會建立）。需要能編輯 Task。 */
  app.post(API_ROUTES.repoSpecs, auth, async (c) => {
    const actor = c.get("actor");
    const { repo, scope } = await loadRepo(actor, readId(c, "repoId", "Repo"));
    requireProjectCapability(actor, scope, "edit_task");
    const input = await readJson(c, CreateRepoSpecInput);
    const [created] = await db
      .insert(repoSpecs)
      .values({ repoId: repo.id, path: input.path, title: input.title })
      .onConflictDoNothing()
      .returning();
    if (!created) throw conflict("這個路徑已經登記過了");
    const [view] = await toRepoSpecs(db, [created]);
    return c.json(view, 201);
  });

  app.get(API_ROUTES.repoSpec, auth, async (c) => {
    const actor = c.get("actor");
    const { spec, scope } = await loadSpec(actor, readId(c, "repoSpecId", "Repo Spec"));
    requireProjectCapability(actor, scope, "view");
    const [view] = await toRepoSpecs(db, [spec]);
    return c.json(view);
  });

  /** 把共同編輯的草稿提交到 repo（開 PR）。需要能編輯 Task。 */
  app.post(API_ROUTES.repoSpecCommit, auth, async (c) => {
    const actor = c.get("actor");
    const { spec, scope } = await loadSpec(actor, readId(c, "repoSpecId", "Repo Spec"));
    requireProjectCapability(actor, scope, "edit_task");
    const input = await readJson(c, RepoSpecCommitInput);
    const [repo] = await db.select().from(repos).where(eq(repos.id, spec.repoId));
    if (repo?.kind === "local") {
      return c.json(await commitLocalSpec(s, actor, spec, repo, input.message));
    }
    if (!s.github.app) {
      throw new ApiError(409, "github_disabled", "Server 沒有設定 GitHub App，無法提交到 repo");
    }
    // 先寫回載入中的草稿，提交的是最新的內容。
    await s.collab.flush();
    const markdown = await s.collab.markdown(collabDocRef("repo-spec-draft", spec.id));
    const result = await s.github.app.commitRepoSpec({
      repoSpecId: spec.id,
      markdown,
      requesterMemberId: actor.memberId,
      ...(input.message && { message: input.message }),
    });
    if (!result.ok) {
      const status = {
        disabled: [409, "github_disabled"],
        spec_not_found: [404, "not_found"],
        invalid_path: [422, "invalid_input"],
        forbidden: [403, "forbidden"],
        repo_not_connected: [409, "repo_not_connected"],
        github_error: [502, "github_error"],
      } as const;
      const [code, error] = status[result.reason];
      throw new ApiError(code, error, result.message);
    }
    const response: RepoSpecCommitResponse = {
      pullRequest: result.pullRequest,
      localCommit: null,
      created: result.created,
      overwritesUpstreamChanges: result.overwritesUpstreamChanges,
    };
    return c.json(response);
  });

  /** 重新向 GitHub 查詢 Repo 的 App 安裝狀態（Admin 以上，與登記 Repo 相同）。 */
  app.post(API_ROUTES.repoRefreshInstallation, auth, async (c) => {
    const actor = c.get("actor");
    const { repo, scope } = await loadRepo(actor, readId(c, "repoId", "Repo"));
    requireProjectCapability(actor, scope, "manage_project");
    if (!s.github.app) {
      throw new ApiError(409, "github_disabled", "Server 沒有設定 GitHub App");
    }
    const result = await s.github.app.refreshRepoInstallation(repo.id, actor.memberId);
    if (result.status === "repo_mismatch") {
      throw new ApiError(
        409,
        "repo_mismatch",
        "GitHub 上同名 repo 的 id 與登記時不同，請刪掉後重新登記",
        {
          githubRepoId: result.githubRepoId,
          registeredGithubRepoId: result.registeredGithubRepoId,
        },
      );
    }
    if (result.status === "not_found") throw notFound("Repo");
    const [updated] = await db.select().from(repos).where(eq(repos.id, repo.id));
    if (!updated) throw notFound("Repo");
    return c.json(toRepo(updated, s.github.installUrl));
  });

  return app;
}

/**
 * 本機 Repo 的 Spec 提交（ADR-0013）：Server 碰不到本機 checkout，交給提交者自己、runner.toml 有對應這個
 * Repo 的 Local Runner 直接 commit 到基準分支；內容有變才 commit，版本在 commit 時加 1。
 */
async function commitLocalSpec(
  s: Services,
  actor: Actor,
  spec: typeof repoSpecs.$inferSelect,
  repo: typeof repos.$inferSelect,
  message: string | undefined,
): Promise<RepoSpecCommitResponse> {
  const { db } = s;
  if (!isCommittableSpecPath(spec.path)) {
    throw new ApiError(
      422,
      "invalid_input",
      `只能提交 repo 內 .github/ 以外的 .md 檔：${spec.path}`,
    );
  }
  const candidates = await db
    .select({ id: runners.id })
    .from(runners)
    .innerJoin(agentAvailabilities, eq(agentAvailabilities.runnerId, runners.id))
    .where(
      and(
        eq(runners.kind, "local"),
        eq(runners.memberId, actor.memberId),
        isNull(runners.revokedAt),
        mapsRepo(repo.githubName),
      ),
    );
  const runnerId = [...new Set(candidates.map((r) => r.id))].find((id) => s.hub.isOnline(id));
  if (!runnerId) {
    throw new ApiError(
      409,
      "runner_offline",
      "需要你自己有對應這個本機 Repo 的 Local Runner 在線上，才能提交 Spec",
    );
  }
  await s.collab.flush();
  const content = await s.collab.markdown(collabDocRef("repo-spec-draft", spec.id));
  const [member] = await db.select().from(members).where(eq(members.id, actor.memberId));
  const subject = message?.trim() || `docs(spec): 更新 ${spec.path}`;
  const result = await s.repoSpecCommits.request(runnerId, {
    repo: repo.githubName,
    base_branch: repo.defaultBranch ?? "main",
    path: spec.path,
    content,
    message: member ? `${subject}\n\n${coAuthor(member)}` : subject,
  });
  if (!result.ok) {
    throw new ApiError(409, "runner_offline", "Local Runner 沒有回應，請確認它在線上後再試一次");
  }
  const outcome = result.outcome;
  if (outcome.outcome === "failed") {
    throw conflict(`無法提交到本機 Repo：${outcome.message}`, { reason: outcome.reason });
  }
  if (outcome.outcome === "committed") {
    await db
      .update(repoSpecs)
      .set({ version: sql`${repoSpecs.version} + 1`, committedSha: outcome.commit_sha })
      .where(eq(repoSpecs.id, spec.id));
  }
  return {
    pullRequest: null,
    localCommit: { commitSha: outcome.commit_sha, changed: outcome.outcome === "committed" },
    created: false,
    overwritesUpstreamChanges: false,
  };
}
