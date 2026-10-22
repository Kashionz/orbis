// Hono 路由，由 Server 掛在 apps/server/src/routes/github.ts 的掛載點：
// - `createGitHubWebhookRoutes` → `/api/webhooks/github`
// - `createGitHubApiRoutes` → `/api/github`
//
// TODO(contract): 下面的 request／response schema 之後移到 packages/api-contract（契約 PR）。

import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { GitHubIntegration } from "./integration";
import { RepoNotConnectedError } from "./issues/import";

export function createGitHubWebhookRoutes(github: Pick<GitHubIntegration, "handleWebhook">): Hono {
  const app = new Hono();
  app.post("/", async (c) => {
    // 簽章是對原始 bytes 計算的，不能先解析 JSON。
    const body = new Uint8Array(await c.req.arrayBuffer());
    const result = await github.handleWebhook({
      headers: { get: (name) => c.req.header(name) },
      body,
    });
    return c.json(result.body, result.status);
  });
  return app;
}

export const InspectRepoQuery = z.object({
  /** 要把 Repo 登記到哪個 Project（用來檢查權限）。 */
  projectId: z.string().min(1),
  owner: z.string().trim().min(1),
  name: z.string().trim().min(1),
});

export const ImportIssuesInput = z
  .object({ issueNumbers: z.array(z.number().int().positive()).min(1).max(100) })
  .strict();

export interface GitHubApiRoutesOptions {
  github: Pick<GitHubIntegration, "inspectRepo" | "listImportableIssues" | "importIssues">;
  /** Server 的登入檢查（沒有登入時擋下）。 */
  authenticate: MiddlewareHandler;
  /** 目前登入的 Member（authenticate 之後一定有值）。 */
  memberIdOf: (c: Context) => string;
  /** 目前的 Member 能不能在這個 Project 登記 Repo（Role 檢查由 Server 負責）。 */
  canManageRepos: (c: Context, projectId: string) => Promise<boolean>;
  /** 目前的 Member 能不能在這個 Repo 所屬的 Project 建立 Task；Repo 不存在時回傳 false。 */
  canCreateTasksInRepo: (c: Context, repoId: string) => Promise<boolean>;
}

export function createGitHubApiRoutes(options: GitHubApiRoutesOptions): Hono {
  const app = new Hono();
  app.use("*", options.authenticate);

  const forbidden = (c: Context) => c.json({ error: "forbidden" }, 403);
  // 以 repoId 為單位檢查權限：不同 Project（甚至不同 Team）的 Repo 不能互相讀取或匯入。
  const canUseRepo = (c: Context) => options.canCreateTasksInRepo(c, c.req.param("repoId") ?? "");

  app.onError((error, c) => {
    if (error instanceof RepoNotConnectedError) {
      return c.json({ error: "repo_not_connected", message: error.message }, 409);
    }
    throw error;
  });

  app.get("/repos/inspect", async (c) => {
    const query = InspectRepoQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "invalid_input", issues: query.error.issues }, 400);
    if (!(await options.canManageRepos(c, query.data.projectId))) return forbidden(c);
    return c.json(await options.github.inspectRepo(query.data.owner, query.data.name));
  });

  app.get("/repos/:repoId/importable-issues", async (c) => {
    if (!(await canUseRepo(c))) return forbidden(c);
    return c.json({ issues: await options.github.listImportableIssues(c.req.param("repoId")) });
  });

  app.post("/repos/:repoId/import", async (c) => {
    if (!(await canUseRepo(c))) return forbidden(c);
    const input = ImportIssuesInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const results = await options.github.importIssues({
      repoId: c.req.param("repoId"),
      issueNumbers: input.data.issueNumbers,
      importedByMemberId: options.memberIdOf(c),
    });
    return c.json({ results });
  });

  return app;
}
