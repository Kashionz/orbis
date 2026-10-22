// HTTP API（Hono）。Runner 的 WebSocket 端點不經過 Hono，見 runner/endpoint.ts。

import { Hono } from "hono";
import type { GitHubOAuth } from "./auth/github-oauth";
import type { Config } from "./config";
import type { Database } from "./db/client";
import type { Logger } from "./logger";
import { createAuthRoutes } from "./routes/auth";
import { createGitHubRoutes, createGitHubWebhookRoutes } from "./routes/github";

export interface AppDeps {
  config: Pick<Config, "publicUrl" | "bootstrapOwnerGithubUserId">;
  db: Database;
  logger: Logger;
  githubOAuth: GitHubOAuth;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    deps.logger.error({ err: error, path: c.req.path }, "處理 HTTP 請求時發生錯誤");
    return c.json({ error: "internal_error", message: "Server 發生錯誤" }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.route(
    "/api/auth",
    createAuthRoutes({
      db: deps.db,
      logger: deps.logger,
      githubOAuth: deps.githubOAuth,
      publicUrl: deps.config.publicUrl,
      bootstrapOwnerGithubUserId: deps.config.bootstrapOwnerGithubUserId,
    }),
  );

  // D 軌（GitHub）的掛載點。
  app.route("/api/github", createGitHubRoutes());
  app.route("/api/webhooks/github", createGitHubWebhookRoutes());

  // E 軌的 Preview 反向代理（/preview/<run-id>/）之後掛在這裡，實作放在 src/preview/。

  return app;
}
