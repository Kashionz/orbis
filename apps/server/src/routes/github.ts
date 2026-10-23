// GitHub 整合的路由（ARCHITECTURE §11），路徑一律取自 API_ROUTES：
//
// - webhook（API_ROUTES.githubWebhook）：packages/github 的 createGitHubWebhookRoutes，
//   簽章驗證與 delivery 去重由它處理，不經過登入檢查。
// - 從 Issue 匯入 Task（API_ROUTES.repoImportableIssues、repoImportIssues）：Server 自己註冊，
//   Role 檢查與錯誤格式和其他端點一致，內部呼叫 GitHub 整合。需要能在該 Project 建立 Task。
//
// 沒有設定 GitHub App 時，webhook 回 404，匯入的端點回 409 `github_disabled`。

import {
  API_ROUTES,
  type ImportableIssue,
  type ImportIssueResult,
  ImportIssuesInput,
} from "@orbis/api-contract";
import { createGitHubWebhookRoutes, RepoNotConnectedError } from "@orbis/github";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { loadProjectScope, requireProjectCapability } from "../authz/scope";
import { repos } from "../db/schema";
import type { GitHubApp } from "../github/integration";
import { ApiError, notFound, readId, readJson } from "../http/errors";
import type { Actor, AppEnv } from "../http/session";
import type { Services } from "../services";

export function createGitHubWebhookRoute(app: GitHubApp | null): Hono {
  const router = new Hono();
  if (app) router.route(API_ROUTES.githubWebhook, createGitHubWebhookRoutes(app));
  return router;
}

export function createGitHubRoutes(s: Services): Hono<AppEnv> {
  const { db, auth } = s;
  const router = new Hono<AppEnv>();

  /** 找出 Repo 並確認 Actor 能在它的 Project 建立 Task；GitHub App 沒有設定時回 409。 */
  const requireImport = async (actor: Actor, repoId: string): Promise<GitHubApp> => {
    const [repo] = await db.select().from(repos).where(eq(repos.id, repoId));
    if (!repo) throw notFound("Repo");
    const scope = await loadProjectScope(db, actor, repo.projectId);
    requireProjectCapability(actor, scope, "edit_task");
    if (!s.github.app) {
      throw new ApiError(409, "github_disabled", "Server 沒有設定 GitHub App，無法從 Issue 匯入");
    }
    return s.github.app;
  };

  /** 把 GitHub 整合的「Repo 沒有接上 App」轉成 409。 */
  const connected = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof RepoNotConnectedError) {
        throw new ApiError(409, "repo_not_connected", "這個 Repo 還沒有安裝 GitHub App");
      }
      throw error;
    }
  };

  /** Repo 中還沒有對應到這個 Project 任何 Task 的 open Issue。 */
  router.get(API_ROUTES.repoImportableIssues, auth, async (c) => {
    const repoId = readId(c, "repoId", "Repo");
    const app = await requireImport(c.get("actor"), repoId);
    const issues = await connected(() => app.listImportableIssues(repoId));
    return c.json(issues satisfies ImportableIssue[]);
  });

  /** 把選定的 Issue 匯入成 Task（狀態一律是 Backlog），回傳每個 Issue 的結果。 */
  router.post(API_ROUTES.repoImportIssues, auth, async (c) => {
    const actor = c.get("actor");
    const repoId = readId(c, "repoId", "Repo");
    const app = await requireImport(actor, repoId);
    const input = await readJson(c, ImportIssuesInput);
    const results = await connected(() =>
      app.importIssues({
        repoId,
        issueNumbers: input.issueNumbers,
        importedByMemberId: actor.memberId,
      }),
    );
    return c.json(results satisfies ImportIssueResult[]);
  });

  return router;
}
