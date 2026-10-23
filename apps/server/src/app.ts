// HTTP API（Hono）。Runner 與 Web 的 WebSocket 端點不經過 Hono，見 runner/endpoint.ts、web/ws.ts。

import { API_ROUTES, type HealthResponse } from "@orbis/api-contract";
import { Hono } from "hono";
import type { GitHubOAuth } from "./auth/github-oauth";
import { endSession } from "./auth/session-cleanup";
import { createBlobRoutes } from "./blobs/routes";
import type { Config } from "./config";
import type { Database } from "./db/client";
import { handleError } from "./http/errors";
import { requireTrustedOrigin } from "./http/origin-check";
import type { Logger } from "./logger";
import { createPreviewRoutes } from "./preview/routes";
import { createAuthRoutes } from "./routes/auth";
import { createCommentRoutes } from "./routes/comments";
import { createDraftRoutes } from "./routes/drafts";
import { createGitHubRoutes, createGitHubWebhookRoute } from "./routes/github";
import { createNotificationRoutes } from "./routes/notifications";
import { createProjectRoutes } from "./routes/projects";
import { createRepoSpecRoutes } from "./routes/repo-specs";
import { createReviewRoutes } from "./routes/review";
import { createRunnerRoutes } from "./routes/runners";
import { createRunRoutes } from "./routes/runs";
import { createTaskRoutes } from "./routes/tasks";
import { createTeamRoutes } from "./routes/team";
import { createServices, type Services } from "./services";

export interface AppDeps {
  config: Pick<Config, "publicUrl" | "bootstrapOwnerGithubUserId"> &
    /** 未提供時以請求的 origin 回應 `/api/health`（測試用；loadConfig 一律會給值）。 */
    Partial<Pick<Config, "apiOrigin">>;
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

  // 帶 session cookie 的寫入請求只接受 Web 與 Server 自己的 Origin（Preview 子網域是 same-site）。
  app.use(
    "*",
    requireTrustedOrigin([
      deps.config.publicUrl,
      ...(deps.config.apiOrigin ? [deps.config.apiOrigin] : []),
    ]),
  );

  app.get(API_ROUTES.health, (c) =>
    c.json({
      ok: true,
      apiOrigin: deps.config.apiOrigin ?? new URL(c.req.url).origin,
    } satisfies HealthResponse),
  );

  app.route(
    "/",
    createAuthRoutes({
      db: deps.db,
      logger: deps.logger,
      githubOAuth: deps.githubOAuth,
      publicUrl: deps.config.publicUrl,
      bootstrapOwnerGithubUserId: deps.config.bootstrapOwnerGithubUserId,
      endSession: (token) => endSession(services, token),
    }),
  );

  // 需要登入的 API。每個路由各自掛上 services.auth，不用 `/api/*` 的 middleware，
  // 避免擋到登入、webhook 與 Runner 的端點。
  // 路徑一律取自契約的 API_ROUTES（已含 `/api` 前綴），所以掛在根目錄。
  app.route("/", createTeamRoutes(services));
  app.route("/", createProjectRoutes(services));
  app.route("/", createTaskRoutes(services));
  app.route("/", createRunRoutes(services));
  app.route("/", createReviewRoutes(services));
  app.route("/", createRunnerRoutes(services));
  app.route("/", createDraftRoutes(services));
  app.route("/", createCommentRoutes(services));
  app.route("/", createRepoSpecRoutes(services));
  app.route("/", createNotificationRoutes(services));

  // blob：Runner 以 Runner token 上傳，Web 以 session 下載。
  const blobRoutes = createBlobRoutes(services);
  app.route("/", blobRoutes.runner);
  app.route("/", blobRoutes.web);

  // GitHub 整合：webhook（不經過登入檢查）與從 Issue 匯入。
  app.route("/", createGitHubWebhookRoute(services.github.app));
  app.route("/", createGitHubRoutes(services));

  // E 軌的 Preview：狀態查詢與 Preview 網址的換票（實作在 src/preview/）。Preview 網址本身的請求
  // 依 Host 在 server.ts 分流，不經過這裡。
  app.route("/", createPreviewRoutes(services));

  return app;
}
