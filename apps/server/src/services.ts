// Server 的服務組裝：HTTP 路由、Runner WebSocket 與背景工作共用同一組服務。

import type { MiddlewareHandler } from "hono";
import { type Clock, systemClock } from "./clock";
import type { Database } from "./db/client";
import { DomainEvents } from "./domain/events";
import { type LifecycleHooks, TaskLifecycleService } from "./domain/task-lifecycle";
import {
  createGitHubUserLookup,
  type GitHubIntegration,
  loggingPullRequestOpener,
  passthroughRepoRegistrar,
} from "./github/integration";
import { type AppEnv, requireActor } from "./http/session";
import type { Logger } from "./logger";

export interface Services {
  db: Database;
  logger: Logger;
  clock: Clock;
  /** 要求已登入的 middleware。 */
  auth: MiddlewareHandler<AppEnv>;
  events: DomainEvents;
  lifecycle: TaskLifecycleService;
  github: GitHubIntegration;
}

export interface ServicesOptions {
  db: Database;
  logger: Logger;
  clock?: Clock;
  /** D 軌的 GitHub 整合；未提供的部分用預設實作（不連 GitHub）。 */
  github?: Partial<GitHubIntegration>;
  lifecycleHooks?: LifecycleHooks;
}

export function createServices(options: ServicesOptions): Services {
  const { db, logger } = options;
  const clock = options.clock ?? systemClock;
  const events = new DomainEvents(logger);
  return {
    db,
    logger,
    clock,
    auth: requireActor(db, clock),
    events,
    lifecycle: new TaskLifecycleService(events, options.lifecycleHooks),
    github: {
      userLookup: options.github?.userLookup ?? createGitHubUserLookup(),
      repoRegistrar: options.github?.repoRegistrar ?? passthroughRepoRegistrar,
      pullRequestOpener: options.github?.pullRequestOpener ?? loggingPullRequestOpener(logger),
      routes: options.github?.routes,
      webhookRoutes: options.github?.webhookRoutes,
    },
  };
}
