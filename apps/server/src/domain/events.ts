// Domain event：Task 的建立、更新、狀態變更、Run 狀態變更與刪除。GitHub 整合（github/app.ts）
// 訂閱它們，把變更同步到 GitHub Issue 並更新狀態摘要留言。一律在 transaction commit 之後才發出。

import type { TaskStatus } from "@orbis/api-contract";
import type { Logger } from "../logger";
import type { TransitionTrigger } from "./task-state-machine";

/**
 * 變更的來源；`github` 表示由 GitHub 整合（Issue 同步、PR webhook）寫入，
 * Server 不再對它呼叫 onTaskChanged，避免同步回音。`collab` 表示由共同編輯的文件回寫
 * （照常同步到 GitHub，但不再寫回文件）。
 */
export type ChangeSource = "api" | "github" | "system" | "collab";

interface TaskEventBase {
  taskId: string;
  projectId: string;
  source: ChangeSource;
  /** 做出修改的 Member；系統觸發時為 null。 */
  actorMemberId?: string | null;
}

export type DomainEvent =
  | ({ type: "task.created" } & TaskEventBase)
  | ({ type: "task.updated"; fields: string[] } & TaskEventBase)
  | ({
      type: "task.status_changed";
      from: TaskStatus;
      to: TaskStatus;
      trigger: TransitionTrigger;
    } & TaskEventBase)
  /** Task 的 Run 狀態改變（顯示在 GitHub Issue 的狀態摘要留言）。 */
  | ({ type: "task.run_changed"; runId: string } & TaskEventBase)
  | { type: "task.deleted"; taskId: string; projectId: string };

export type DomainEventListener = (event: DomainEvent) => void | Promise<void>;

export class DomainEvents {
  private readonly listeners = new Set<DomainEventListener>();

  constructor(private readonly logger: Logger) {}

  /** 訂閱所有 domain event，回傳取消訂閱的函式。 */
  subscribe(listener: DomainEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 依序通知每個訂閱者；單一訂閱者失敗只記 log，不影響其他人與呼叫端。 */
  async emit(event: DomainEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        this.logger.error({ err: error, event }, "domain event 的訂閱者處理失敗");
      }
    }
  }
}
