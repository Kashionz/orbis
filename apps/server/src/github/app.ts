// 組裝 GitHub App 整合（packages/github）：接上 Server 的 DomainService、GitHubStore、Notifier，
// 並訂閱 domain event，Task 在 Orbis 中改變後同步到 GitHub Issue（ARCHITECTURE §11）。

import {
  createGitHubIntegration,
  type GitHubAppConfig,
  type GitHubClient,
  installUrl,
  type Notifier,
} from "@orbis/github";
import type { Clock } from "../clock";
import type { Database } from "../db/client";
import type { DomainEvents } from "../domain/events";
import { GitHubDomainService } from "../domain/github-domain";
import type { TaskLifecycleService } from "../domain/task-lifecycle";
import type { Logger } from "../logger";
import type { Notify } from "../notifications/types";
import type { GitHubApp } from "./integration";
import { DrizzleGitHubStore } from "./store";

export interface GitHubAppOptions {
  config: GitHubAppConfig;
  /** 測試用：替換 GitHub API 的呼叫（例如 @orbis/github/testing 的 FakeGitHub）。 */
  client?: GitHubClient;
  /** 測試用：替換通知（預設交給通知系統）。 */
  notifier?: Notifier;
}

/** Task 在 Web UI 上的網址（Web 的路由 `/tasks/<Task Key>`）。 */
export function taskUrl(publicUrl: string, taskKey: string): string {
  return `${publicUrl}/tasks/${encodeURIComponent(taskKey)}`;
}

/**
 * GitHub 整合的通知交給通知系統（ARCHITECTURE §12.3）：
 * - `pr_merged` → 自己的 Task 被 merge（`task_merged`）。
 * - `pr_closed_unmerged` → 自己的 Task 被退回（`task_rejected`）。
 * - `feedback_limit_reached` → Feedback Loop 達到次數上限。
 * - `pr_open_failed` 不另外通知：開 PR 失敗時 run-control 已經建立「停下來的 Run」並通知。
 */
export function notificationNotifier(notify: Notify, logger: Logger): Notifier {
  return {
    async notify(notification) {
      const kind = notification.kind as string;
      const mapped =
        kind === "pr_merged"
          ? "task_merged"
          : kind === "pr_closed_unmerged"
            ? "task_rejected"
            : kind === "feedback_limit_reached"
              ? "feedback_limit_reached"
              : null;
      if (!mapped) {
        logger.debug({ notification }, "GitHub 整合的通知由其他地方處理，略過");
        return;
      }
      await notify.notify(null, {
        kind: mapped,
        recipients: [notification.memberId],
        taskId: notification.taskId,
        title: notification.message,
        body: notification.url ?? null,
      });
    },
  };
}

export function createGitHubApp(
  options: GitHubAppOptions,
  deps: {
    db: Database;
    lifecycle: TaskLifecycleService;
    events: DomainEvents;
    clock: Clock;
    logger: Logger;
    notify: Notify;
    publicUrl: string;
  },
): { app: GitHubApp; installUrl: string; idle: () => Promise<void> } {
  const logger = deps.logger.child({ component: "github" });
  const app = createGitHubIntegration({
    config: options.config,
    domain: new GitHubDomainService(deps.db, deps.lifecycle),
    store: new DrizzleGitHubStore(deps.db),
    notifier: options.notifier ?? notificationNotifier(deps.notify, logger),
    logger,
    taskUrl: (task) => taskUrl(deps.publicUrl, task.key),
    now: () => deps.clock.now(),
    ...(options.client && { client: options.client }),
  });

  // 同步在背景執行，不拖慢 API 的回應；同一個 Task 的同步由 packages/github 依序處理。
  // GitHub 整合自己寫入的變更（source = github）不再同步回去，避免回音。
  const pending = new Set<Promise<void>>();
  deps.events.subscribe((event) => {
    if (event.type === "task.deleted" || event.source === "github") return;
    const actorMemberId = event.actorMemberId ?? undefined;
    const job = app
      .onTaskChanged(event.taskId, actorMemberId ? { actorMemberId } : {})
      .then((outcome) =>
        logger.debug({ event: event.type, taskId: event.taskId, outcome }, "已同步 Task 到 GitHub"),
      )
      .catch((error: unknown) =>
        logger.error({ err: error, taskId: event.taskId }, "同步 Task 到 GitHub 失敗"),
      )
      .finally(() => pending.delete(job));
    pending.add(job);
  });

  return {
    app,
    installUrl: installUrl(options.config.slug),
    /** 等背景的同步都做完（測試與關閉 Server 時用）。 */
    idle: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
