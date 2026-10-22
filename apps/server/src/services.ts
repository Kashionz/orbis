// Server 的服務組裝：HTTP 路由、Runner WebSocket 與背景工作共用同一組服務。

import type { MiddlewareHandler } from "hono";
import { BlobCleanup } from "./blobs/cleanup";
import { type BlobStore, FileSystemBlobStore } from "./blobs/store";
import { type Clock, systemClock } from "./clock";
import { DEFAULT_BLOB_DIR, DEFAULT_HEARTBEAT_INTERVAL_MS } from "./config";
import type { Database } from "./db/client";
import { DomainEvents } from "./domain/events";
import { GitHubDomainService } from "./domain/github-domain";
import { type LifecycleHooks, TaskLifecycleService } from "./domain/task-lifecycle";
import {
  createGitHubUserLookup,
  type GitHubIntegration,
  loggingPullRequestOpener,
  passthroughRepoRegistrar,
} from "./github/integration";
import { type AppEnv, requireActor } from "./http/session";
import type { Logger } from "./logger";
import { Dispatcher } from "./runner/dispatcher";
import { RunnerHub } from "./runner/hub";
import { EventIngest } from "./runs/event-ingest";
import { EventStore } from "./runs/event-store";
import { RunControlService } from "./runs/run-control";

export interface Services {
  db: Database;
  logger: Logger;
  clock: Clock;
  /** 要求已登入的 middleware。 */
  auth: MiddlewareHandler<AppEnv>;
  events: DomainEvents;
  lifecycle: TaskLifecycleService;
  github: GitHubIntegration;
  /** 給 D 軌呼叫的 domain service（PR merge、Issue 關閉等）。 */
  githubDomain: GitHubDomainService;
  hub: RunnerHub;
  eventStore: EventStore;
  dispatcher: Dispatcher;
  ingest: EventIngest;
  runControls: RunControlService;
  blobStore: BlobStore;
  blobCleanup: BlobCleanup;
  heartbeatIntervalMs: number;
}

export interface ServicesOptions {
  db: Database;
  logger: Logger;
  clock?: Clock;
  /** D 軌的 GitHub 整合；未提供的部分用預設實作（不連 GitHub）。 */
  github?: Partial<GitHubIntegration>;
  lifecycleHooks?: LifecycleHooks;
  heartbeatIntervalMs?: number;
  offerTimeoutMs?: number;
  rejectCooldownMs?: number;
  /** 未提供時存在 blobDir（預設 DEFAULT_BLOB_DIR）。 */
  blobStore?: BlobStore;
  blobDir?: string;
}

export function createServices(options: ServicesOptions): Services {
  const { db, logger } = options;
  const clock = options.clock ?? systemClock;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const events = new DomainEvents(logger);
  const lifecycle = new TaskLifecycleService(events, options.lifecycleHooks);
  const github: GitHubIntegration = {
    userLookup: options.github?.userLookup ?? createGitHubUserLookup(),
    repoRegistrar: options.github?.repoRegistrar ?? passthroughRepoRegistrar,
    pullRequestOpener: options.github?.pullRequestOpener ?? loggingPullRequestOpener(logger),
    routes: options.github?.routes,
    webhookRoutes: options.github?.webhookRoutes,
  };
  const hub = new RunnerHub();
  const eventStore = new EventStore(db);
  const dispatcher = new Dispatcher({
    db,
    hub,
    eventStore,
    clock,
    logger,
    heartbeatIntervalMs,
    offerTimeoutMs: options.offerTimeoutMs,
    rejectCooldownMs: options.rejectCooldownMs,
  });
  const blobStore =
    options.blobStore ?? new FileSystemBlobStore(options.blobDir ?? DEFAULT_BLOB_DIR);
  return {
    db,
    logger,
    clock,
    auth: requireActor(db, clock),
    events,
    lifecycle,
    github,
    githubDomain: new GitHubDomainService(db, lifecycle),
    hub,
    eventStore,
    dispatcher,
    ingest: new EventIngest(db, eventStore, lifecycle, clock, logger),
    runControls: new RunControlService(db, hub, clock, logger, github.pullRequestOpener),
    blobStore,
    blobCleanup: new BlobCleanup(db, blobStore, clock, logger),
    heartbeatIntervalMs,
  };
}
