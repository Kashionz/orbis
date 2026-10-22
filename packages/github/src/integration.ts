// 組裝 GitHub 整合，提供給 Server 使用。

import type { InstallationToken } from "./auth/installation-tokens";
import { createHttpGitHubClient } from "./client/http";
import type { GitHubClient } from "./client/types";
import type { GitHubAppConfig } from "./config";
import type { IntegrationContext } from "./context";
import {
  type ImportableIssue,
  type ImportResult,
  importIssues,
  listImportableIssues,
} from "./issues/import";
import { type PushOutcome, pushTask } from "./issues/sync";
import { KeyedMutex } from "./keyed-mutex";
import type { DomainService, GitHubStore, Logger, Notifier, TaskRecord } from "./ports";
import { type BranchPushed, type OpenPullRequestResult, openPullRequest } from "./pull-requests";
import { getInstallationTokenForRepo, inspectRepo, type RepoInspection } from "./repos";
import { handleWebhook, type WebhookRequest, type WebhookResult } from "./webhook/handler";

export interface GitHubIntegrationOptions {
  config: GitHubAppConfig;
  domain: DomainService;
  store: GitHubStore;
  notifier: Notifier;
  logger: Logger;
  /** Task 在 Web UI 上的網址（Web 的路由由 C 軌決定）。 */
  taskUrl: (task: TaskRecord) => string;
  /** 測試用：替換 GitHub API 的呼叫。 */
  client?: GitHubClient;
  /** 測試用：替換 fetch（client 未指定時才使用）。 */
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Server 使用的 GitHub 整合介面。 */
export interface GitHubIntegration {
  /** `POST /api/webhooks/github` 的處理。 */
  handleWebhook(request: WebhookRequest): Promise<WebhookResult>;
  /**
   * Task 在 Orbis 中被建立或修改（title、描述、狀態、負責人、labels、Acceptance Criterion 的結果、
   * Run 狀態）之後由 Server 呼叫：建立或更新對應的 Issue 與狀態摘要留言。
   * 由這個套件透過 DomainService 發起的寫入不需要呼叫。
   */
  onTaskChanged(taskId: string): Promise<PushOutcome>;
  /** Runner 回報 `branch_pushed` 之後由 Server 呼叫：以 App 身分開 PR。 */
  onBranchPushed(pushed: BranchPushed): Promise<OpenPullRequestResult>;
  /** Project 新增 Repo 時檢查 App 安裝狀態並讀取 default branch。 */
  inspectRepo(owner: string, name: string): Promise<RepoInspection>;
  /** 給 Team Runner push 用、只限這個 repo 的 installation token。 */
  getInstallationTokenForRepo(repoId: string): Promise<InstallationToken>;
  listImportableIssues(repoId: string): Promise<ImportableIssue[]>;
  importIssues(input: {
    repoId: string;
    issueNumbers: readonly number[];
    importedByMemberId: string;
  }): Promise<ImportResult[]>;
}

export function createGitHubIntegration(options: GitHubIntegrationOptions): GitHubIntegration {
  const client =
    options.client ??
    createHttpGitHubClient({
      appId: options.config.appId,
      privateKey: options.config.privateKey,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  const ctx: IntegrationContext = {
    client,
    domain: options.domain,
    store: options.store,
    notifier: options.notifier,
    logger: options.logger,
    taskUrl: options.taskUrl,
    appSlug: options.config.slug,
    now: options.now ?? (() => new Date()),
    taskLocks: new KeyedMutex(),
  };

  return {
    handleWebhook: (request) => handleWebhook(ctx, options.config.webhookSecret, request),
    onTaskChanged: (taskId) => pushTask(ctx, taskId),
    onBranchPushed: (pushed) => openPullRequest(ctx, pushed),
    inspectRepo: (owner, name) => inspectRepo(ctx, owner, name),
    getInstallationTokenForRepo: (repoId) => getInstallationTokenForRepo(ctx, repoId),
    listImportableIssues: (repoId) => listImportableIssues(ctx, repoId),
    importIssues: (input) => importIssues(ctx, input),
  };
}
