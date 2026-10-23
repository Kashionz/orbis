// GitHub webhook 的 Hono 路由。Server 在 apps/server/src/routes/github.ts 把它掛在
// `API_ROUTES.githubWebhook`，不經過登入檢查（由簽章驗證把關）。
//
// 從 Issue 匯入 Task 的端點由 Server 依 `API_ROUTES` 提供，內部呼叫 GitHubIntegration。

import { Hono } from "hono";
import type { GitHubIntegration } from "./integration";

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
