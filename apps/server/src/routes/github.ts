// GitHub 整合的掛載點（D 軌，packages/github）。
//
// - `/api/github/*`：Repo 登記、從 Issue 匯入等 API。
// - `/api/webhooks/github`：GitHub App 的 webhook（簽章驗證與 delivery ID 去重由 D 軌實作）。
//
// D 軌在組裝 Server 時以 `GitHubIntegration.routes`／`webhookRoutes` 傳入自己的路由；
// 沒有傳入時是空的 router。

import { Hono } from "hono";
import type { GitHubRoutes } from "../github/integration";

export function createGitHubRoutes(github: GitHubRoutes = {}): Hono {
  return github.routes ?? new Hono();
}

export function createGitHubWebhookRoutes(github: GitHubRoutes = {}): Hono {
  return github.webhookRoutes ?? new Hono();
}
