// HTTP API（Hono）。Runner 與 Web 的 WebSocket 端點不經過 Hono，見 runner/endpoint.ts、web/ws.ts。

import { Hono } from "hono";
import type { GitHubOAuth } from "./auth/github-oauth";
import { createBlobRoutes } from "./blobs/routes";
import type { Config } from "./config";
import type { Database } from "./db/client";
import { handleError } from "./http/errors";
import type { Logger } from "./logger";
import { createAuthRoutes } from "./routes/auth";
import { createGitHubRoutes, createGitHubWebhookRoutes } from "./routes/github";
import { createProjectRoutes } from "./routes/projects";
import { createReviewRoutes } from "./routes/review";
import { createRunnerRoutes } from "./routes/runners";
import { createRunRoutes } from "./routes/runs";
import { createTaskRoutes } from "./routes/tasks";
import { createTeamRoutes } from "./routes/team";
import { createServices, type Services } from "./services";

export interface AppDeps {
  config: Pick<Config, "publicUrl" | "bootstrapOwnerGithubUserId">;
  db: Database;
  logger: Logger;
  githubOAuth: GitHubOAuth;
  /** 未提供時以 db、logger 建立預設的服務。 */
  services?: Services;
}

export function createApp(deps: AppDeps): Hono {
  const services = deps.services ?? createServices({ db: deps.db, logger: deps.logger });
  const app = new Hono();

  app.onError(handleError(deps.logger));

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

  // 需要登入的 API。每個路由各自掛上 services.auth，不用 `/api/*` 的 middleware，
  // 避免擋到登入、webhook 與 Runner 的端點。
  app.route("/api", createTeamRoutes(services));
  app.route("/api", createProjectRoutes(services));
  app.route("/api", createTaskRoutes(services));
  app.route("/api", createRunRoutes(services));
  app.route("/api", createReviewRoutes(services));
  app.route("/api", createRunnerRoutes(services));

  // blob：Runner 以 Runner token 上傳，Web 以 session 下載。
  const blobRoutes = createBlobRoutes(services);
  app.route("/", blobRoutes.runner);
  app.route("/api", blobRoutes.web);

  // D 軌（GitHub）的掛載點。
  app.route("/api/github", createGitHubRoutes(services.github));
  app.route("/api/webhooks/github", createGitHubWebhookRoutes(services.github));

  // E 軌的 Preview 反向代理（/preview/<run-id>/）之後掛在這裡，實作放在 src/preview/。

  return app;
}
