// 各模組共用的依賴。

import type { GitHubClient, RepoRef } from "./client/types";
import type { KeyedMutex } from "./keyed-mutex";
import type {
  DomainService,
  FeedbackDependencies,
  GitHubStore,
  Logger,
  Notifier,
  RepoRecord,
  RepoSpecDependencies,
  TaskRecord,
} from "./ports";
import type { WebhookSender } from "./webhook/payloads";

export interface IntegrationContext {
  client: GitHubClient;
  domain: DomainService;
  store: GitHubStore;
  notifier: Notifier;
  logger: Logger;
  /** Task 在 Web UI 上的網址。 */
  taskUrl: (task: TaskRecord) => string;
  /** App 的 slug。 */
  appSlug: string;
  now: () => Date;
  /** 以 Task ID 為 key，序列化同一個 Task 的同步。 */
  taskLocks: KeyedMutex;
  /** Feedback Loop 的依賴；Server 沒有提供時為 null（Feedback Loop 停用）。 */
  feedback: FeedbackDependencies | null;
  /** Repo Spec 提交的依賴；Server 沒有提供時為 null。 */
  repoSpecs: RepoSpecDependencies | null;
}

/** 已安裝 App、可以呼叫 API 的 Repo。 */
export interface ConnectedRepo {
  record: RepoRecord;
  installationId: number;
  githubRepoId: number;
  ref: RepoRef;
}

export function connectedRepo(record: RepoRecord): ConnectedRepo | null {
  if (record.installationId === null || record.githubRepoId === null) return null;
  return {
    record,
    installationId: record.installationId,
    githubRepoId: record.githubRepoId,
    ref: { owner: record.owner, name: record.name },
  };
}

/** App 自己的 bot 帳號的 login，例如 `orbis-dev[bot]`。 */
export function appBotLogin(appSlug: string): string {
  return `${appSlug}[bot]`;
}

/** 這則 webhook 是不是 App 自己的寫入造成的（同步的回音）。 */
export function isOwnEcho(ctx: IntegrationContext, sender: WebhookSender): boolean {
  return sender.type === "Bot" && sender.login === appBotLogin(ctx.appSlug);
}

/** 要通知的 Member：負責人，沒有負責人時是建立者。 */
export function taskOwner(task: TaskRecord): string | null {
  return task.assigneeMemberId ?? task.createdByMemberId;
}
