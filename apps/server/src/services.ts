// Server 的服務組裝：HTTP 路由、Runner WebSocket 與背景工作共用同一組服務。

import type { MiddlewareHandler } from "hono";
import { SessionCleanup } from "./auth/session-cleanup";
import { BlobCleanup } from "./blobs/cleanup";
import { type BlobStore, FileSystemBlobStore } from "./blobs/store";
import { type Clock, systemClock } from "./clock";
import { CollabHub } from "./collab/hub";
import { type CollabStore, PostgresCollabStore } from "./collab/store";
import { DEFAULT_BLOB_DIR, DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_PUBLIC_URL } from "./config";
import type { Database } from "./db/client";
import { DomainEvents } from "./domain/events";
import { TaskLifecycleService } from "./domain/task-lifecycle";
import { createGitHubApp, type GitHubAppOptions } from "./github/app";
import {
  createGitHubUserLookup,
  createPullRequestOpener,
  type GitHubIntegration,
  type GitHubUserLookup,
  type PullRequestOpener,
} from "./github/integration";
import { type AppEnv, requireActor } from "./http/session";
import type { Logger } from "./logger";
import { type Mailer, NO_MAILER } from "./mail/mailer";
import { MentionService } from "./mentions/service";
import { DesktopChannel, InAppChannel, WebPushHub } from "./notifications/channels";
import { NotificationService } from "./notifications/service";
import { createPreviewService, type PreviewService } from "./preview";
import { Dispatcher } from "./runner/dispatcher";
import { RunnerHub } from "./runner/hub";
import { RepoSpecCommits } from "./runner/repo-spec-commits";
import { ArchiveService } from "./runs/archive";
import { EventIngest } from "./runs/event-ingest";
import { EventStore } from "./runs/event-store";
import { FeedbackRunService } from "./runs/feedback";
import { RunControlService } from "./runs/run-control";
import { VerificationService } from "./runs/verification";
import { TerminalHub } from "./terminal/hub";
import { delegationToolHandlers } from "./tools/delegation-tools";
import { RunWatch } from "./tools/run-watch";
import { OrbisToolService } from "./tools/service";
import { taskToolHandlers } from "./tools/task-tools";

export interface Services {
  db: Database;
  logger: Logger;
  clock: Clock;
  /** 要求已登入的 middleware。 */
  auth: MiddlewareHandler<AppEnv>;
  events: DomainEvents;
  lifecycle: TaskLifecycleService;
  github: GitHubIntegration;
  /** 等背景的 GitHub 同步做完（沒有設定 GitHub App 時立即完成）。 */
  githubIdle: () => Promise<void>;
  hub: RunnerHub;
  eventStore: EventStore;
  dispatcher: Dispatcher;
  ingest: EventIngest;
  runControls: RunControlService;
  /** Task 轉 Done 或刪除時封存 Run 的 Worktree（RunControl `archive`，§6.2）。 */
  archive: ArchiveService;
  blobStore: BlobStore;
  blobCleanup: BlobCleanup;
  sessionCleanup: SessionCleanup;
  verification: VerificationService;
  /** Feedback Loop 的修正 Run（GitHub 整合的 FeedbackRunPort）。 */
  feedbackRuns: FeedbackRunService;
  /** Orbis MCP 工具呼叫的處理。 */
  tools: OrbisToolService;
  /** Run 狀態變化的程序內通知（阻塞的工具呼叫在這裡等）。 */
  watch: RunWatch;
  notify: NotificationService;
  /** @mention 的處理（通知、@agent 建立 consult Run）。 */
  mentions: MentionService;
  /** 每位 Member 的 Web 連線（推送通知）。 */
  webPush: WebPushHub;
  /** 共同編輯的文件（載入、寫回、與資料庫內容同步）。 */
  collab: CollabHub;
  heartbeatIntervalMs: number;
  /** Preview 網址的換票與登入保護（E 軌，src/preview/）。 */
  preview: PreviewService;
  /** 寄信（Task 邀請、預覽邀請）；沒有設定 SMTP 時不寄。 */
  mailer: Mailer;
  /** Web 的 origin：邀請連結、信件中的網址。 */
  publicUrl: string;
  /** 互動式終端機的轉送。 */
  terminals: TerminalHub;
  /** 本機 Repo 的 Spec 提交（等 Local Runner 的結果）。 */
  repoSpecCommits: RepoSpecCommits;
}

export interface ServicesOptions {
  db: Database;
  logger: Logger;
  clock?: Clock;
  /** GitHub 整合。`app` 未提供時不連 GitHub App（Repo 登記、Issue 同步、開 PR 都停用）。 */
  github?: {
    app?: GitHubAppOptions;
    userLookup?: GitHubUserLookup;
    /** 測試用：取代以 GitHub App 開 PR。 */
    pullRequestOpener?: PullRequestOpener;
  };
  /** Web 的 origin（GitHub Issue 中的 Task 連結），預設 DEFAULT_PUBLIC_URL。 */
  publicUrl?: string;
  heartbeatIntervalMs?: number;
  offerTimeoutMs?: number;
  rejectCooldownMs?: number;
  /** 未提供時存在 blobDir（預設 DEFAULT_BLOB_DIR）。 */
  blobStore?: BlobStore;
  blobDir?: string;
  /** Preview 網域（CONFIG_ENV.previewDomain）；未提供時不提供 Preview 網址。 */
  previewDomain?: string | null;
  /** 共同編輯文件的快照儲存，預設存在 Postgres。 */
  collabStore?: CollabStore;
  /** 共同編輯文件修改後多久寫回（測試用）。 */
  collabPersistDebounceMs?: number;
  /** 未提供時不寄信。 */
  mailer?: Mailer;
}

export function createServices(options: ServicesOptions): Services {
  const { db, logger } = options;
  const clock = options.clock ?? systemClock;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const events = new DomainEvents(logger);
  const lifecycle = new TaskLifecycleService(events);
  const webPush = new WebPushHub();
  const notify = new NotificationService({
    db,
    clock,
    logger,
    channels: [new InAppChannel(webPush), new DesktopChannel()],
  });
  notify.watch(events);
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
  const feedbackRuns = new FeedbackRunService({ db, lifecycle, hub, dispatcher });
  const githubApp = options.github?.app
    ? createGitHubApp(options.github.app, {
        db,
        lifecycle,
        events,
        clock,
        logger,
        notify,
        feedbackRuns,
        publicUrl: options.publicUrl ?? DEFAULT_PUBLIC_URL,
      })
    : null;
  const github: GitHubIntegration = {
    userLookup: options.github?.userLookup ?? createGitHubUserLookup(),
    app: githubApp?.app ?? null,
    installUrl: githubApp?.installUrl ?? null,
    pullRequestOpener:
      options.github?.pullRequestOpener ?? createPullRequestOpener(githubApp?.app ?? null, logger),
  };
  const blobStore =
    options.blobStore ?? new FileSystemBlobStore(options.blobDir ?? DEFAULT_BLOB_DIR);
  const sessionCleanup = new SessionCleanup({ db, clock, hub, dispatcher }, logger);
  const runControls = new RunControlService(
    db,
    hub,
    clock,
    logger,
    github.pullRequestOpener,
    notify,
  );
  const archive = new ArchiveService({ db, hub, logger, runControls, events });
  const verification = new VerificationService({ lifecycle, runControls, notify, clock, logger });
  const watch = new RunWatch();
  const mentions = new MentionService({ notify, dispatcher, logger });
  const tools = new OrbisToolService({ db, hub, clock, logger });
  tools.register(taskToolHandlers(db));
  tools.register(delegationToolHandlers({ db, dispatcher, watch, notify, clock }));
  return {
    db,
    logger,
    clock,
    auth: requireActor(db, clock),
    events,
    lifecycle,
    github,
    githubIdle: githubApp?.idle ?? (async () => {}),
    hub,
    eventStore,
    dispatcher,
    ingest: new EventIngest({
      db,
      store: eventStore,
      lifecycle,
      verification,
      runControls,
      watch,
      notify,
      clock,
      logger,
      onFeedbackRunEnded: async (runId) => {
        await githubApp?.app.onFeedbackRunEnded({ runId });
      },
    }),
    runControls,
    archive,
    verification,
    feedbackRuns,
    tools,
    watch,
    webPush,
    mentions,
    notify,
    blobStore,
    blobCleanup: new BlobCleanup(db, blobStore, clock, logger),
    sessionCleanup,
    collab: new CollabHub({
      db,
      mentions,
      store: options.collabStore ?? new PostgresCollabStore(db),
      events,
      logger,
      persistDebounceMs: options.collabPersistDebounceMs,
    }),
    heartbeatIntervalMs,
    preview: createPreviewService({
      db,
      clock,
      domain: options.previewDomain,
      publicUrl: options.publicUrl ?? DEFAULT_PUBLIC_URL,
    }),
    mailer: options.mailer ?? NO_MAILER,
    terminals: new TerminalHub({ db, hub, clock, logger }),
    repoSpecCommits: new RepoSpecCommits(hub),
    publicUrl: options.publicUrl ?? DEFAULT_PUBLIC_URL,
  };
}
