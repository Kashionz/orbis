// 通知系統（ARCHITECTURE §12.3）。
//
// 1. 收件者去掉重複、null 與操作者本人。
// 2. 套用個人設定：關閉的事件類型兩個 Channel 都不送（不建立通知）；勿擾時段只壓住桌面推送
//    （desktop = false），App 內照常記錄，結束後也不補推。
// 3. 存進 notifications，commit 之後交給各 Channel。
//
// 另外訂閱 domain event，在 Task 被指派給別人時通知新的負責人。

import type { Notification } from "@orbis/api-contract";
import { eq, inArray } from "drizzle-orm";
import type { Clock } from "../clock";
import type { Database } from "../db/client";
import { notificationPreferences, notifications, tasks } from "../db/schema";
import { inTransaction, type UnitOfWork } from "../db/tx";
import type { DomainEvents } from "../domain/events";
import { toNotification } from "../http/dto";
import type { Logger } from "../logger";
import type { DeliveredNotification, NotificationChannel } from "./channels";
import { isInQuietHours } from "./quiet-hours";
import type { Notify, NotifyRequest } from "./types";

export interface NotificationServiceDeps {
  db: Database;
  clock: Clock;
  logger: Logger;
  channels: NotificationChannel[];
}

export class NotificationService implements Notify {
  private readonly log: Logger;

  constructor(private readonly deps: NotificationServiceDeps) {
    this.log = deps.logger.child({ component: "notifications" });
  }

  async notify(uow: UnitOfWork | null, request: NotifyRequest): Promise<void> {
    if (uow) {
      await this.create(uow, request);
      return;
    }
    try {
      await inTransaction(this.deps.db, (own) => this.create(own, request));
    } catch (error) {
      this.log.error({ err: error, kind: request.kind }, "建立通知失敗");
    }
  }

  /** 訂閱 domain event：Task 被指派給別人時通知新的負責人。 */
  watch(events: DomainEvents): void {
    events.subscribe(async (event) => {
      if (event.type !== "task.created" && event.type !== "task.updated") return;
      if (event.type === "task.updated" && !event.fields.includes("assigneeMemberId")) return;
      const [task] = await this.deps.db.select().from(tasks).where(eq(tasks.id, event.taskId));
      if (!task?.assigneeMemberId) return;
      await this.notify(null, {
        kind: "task_assigned",
        recipients: [task.assigneeMemberId],
        taskId: task.id,
        actorMemberId: event.actorMemberId ?? null,
        title: `${task.key} 指派給你`,
        body: task.title,
      });
    });
  }

  private async create(uow: UnitOfWork, request: NotifyRequest): Promise<void> {
    const { tx } = uow;
    const recipients = [
      ...new Set(request.recipients.filter((r): r is string => typeof r === "string" && r !== "")),
    ].filter((r) => r !== request.actorMemberId);
    if (recipients.length === 0) return;
    const [task] = request.taskId
      ? await tx.select({ key: tasks.key }).from(tasks).where(eq(tasks.id, request.taskId))
      : [];
    const preferences = await tx
      .select()
      .from(notificationPreferences)
      .where(inArray(notificationPreferences.memberId, recipients));
    const now = this.deps.clock.now();
    const delivered: DeliveredNotification[] = [];
    for (const memberId of recipients) {
      const pref = preferences.find((p) => p.memberId === memberId);
      if (pref?.disabledKinds.includes(request.kind)) continue;
      const quiet =
        pref && pref.quietHoursStartMinute !== null && pref.quietHoursEndMinute !== null
          ? {
              startMinute: pref.quietHoursStartMinute,
              endMinute: pref.quietHoursEndMinute,
              timeZone: pref.timeZone ?? "UTC",
            }
          : null;
      const desktop = !isInQuietHours(now, quiet);
      const [row] = await tx
        .insert(notifications)
        .values({
          memberId,
          kind: request.kind,
          taskId: request.taskId,
          runId: request.runId ?? null,
          gateId: request.gateId ?? null,
          actorMemberId: request.actorMemberId ?? null,
          title: request.title,
          body: request.body ?? null,
          url: request.url ?? (task ? `/tasks/${encodeURIComponent(task.key)}` : null),
          desktop,
          createdAt: now,
        })
        .returning();
      if (!row) continue;
      const notification: Notification = toNotification(row, task?.key ?? null);
      delivered.push({ memberId, notification, desktop });
    }
    uow.afterCommit(async () => {
      for (const item of delivered) {
        for (const channel of this.deps.channels) {
          try {
            await channel.deliver(item);
          } catch (error) {
            this.log.warn({ err: error, channel: channel.id }, "通知 Channel 發送失敗");
          }
        }
      }
    });
  }
}
