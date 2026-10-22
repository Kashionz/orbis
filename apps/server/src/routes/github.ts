// GitHub 整合的掛載點（D 軌，packages/github）。
//
// - `/api/github/*`：Repo 登記、從 Issue 匯入等 API。
// - `/api/webhooks/github`：GitHub App 的 webhook（簽章驗證與 delivery ID 去重由 D 軌實作）。
//
// 00 階段只建立空的 router，D 軌完成後在這裡掛上 packages/github 提供的路由。

import { Hono } from "hono";

export function createGitHubRoutes(): Hono {
  return new Hono();
}

export function createGitHubWebhookRoutes(): Hono {
  return new Hono();
}
