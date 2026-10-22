// Domain event：Task 的建立、更新、狀態變更與刪除。D 軌（packages/github）訂閱它們，
// 把變更同步到 GitHub Issue 並更新狀態摘要留言。一律在 transaction commit 之後才發出。

import type { TaskStatus } from "@orbis/api-contract";
import type { Logger } from "../logger";
import type { TransitionTrigger } from "./task-state-machine";

export type DomainEvent =
  | { type: "task.created"; taskId: string; projectId: string }
  | { type: "task.updated"; taskId: string; projectId: string; fields: string[] }
  | {
      type: "task.status_changed";
      taskId: string;
      projectId: string;
      from: TaskStatus;
      to: TaskStatus;
      trigger: TransitionTrigger;
    }
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
