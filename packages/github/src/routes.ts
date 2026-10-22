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
  owner: z.string().trim().min(1),
  name: z.string().trim().min(1),
});

export const ImportIssuesInput = z
  .object({ issueNumbers: z.array(z.number().int().positive()).min(1).max(100) })
  .strict();

export interface GitHubApiRoutesOptions {
  github: Pick<GitHubIntegration, "inspectRepo" | "listImportableIssues" | "importIssues">;
  /** Server 的登入與 Role 檢查（建立 Task 所需的權限）。 */
  authorize: MiddlewareHandler;
  /** 目前登入的 Member（authorize 之後一定有值）。 */
  memberIdOf: (c: Context) => string;
}

export function createGitHubApiRoutes(options: GitHubApiRoutesOptions): Hono {
  const app = new Hono();
  app.use("*", options.authorize);

  app.onError((error, c) => {
    if (error instanceof RepoNotConnectedError) {
      return c.json({ error: "repo_not_connected", message: error.message }, 409);
    }
    throw error;
  });

  app.get("/repos/inspect", async (c) => {
    const query = InspectRepoQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "invalid_input", issues: query.error.issues }, 400);
    return c.json(await options.github.inspectRepo(query.data.owner, query.data.name));
  });

  app.get("/repos/:repoId/importable-issues", async (c) => {
    return c.json({ issues: await options.github.listImportableIssues(c.req.param("repoId")) });
  });

  app.post("/repos/:repoId/import", async (c) => {
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
