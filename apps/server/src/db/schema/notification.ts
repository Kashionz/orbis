// 通知與個人的通知設定（ARCHITECTURE §12.3）。

import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz, updatedAt } from "./columns";
import { notificationKindEnum } from "./enums";
import { gates } from "./gate";
import { runs } from "./run";
import { tasks } from "./task";
import { members } from "./team";

/**
 * 一則通知（App 內的 Channel）。建立時已套用收件者的設定：關閉的事件類型不會建立；
 * desktop 表示是否要推送到桌面（勿擾時段中建立的為 false），Electron 輪詢的桌面 feed 只看 desktop。
 */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    kind: notificationKindEnum("kind").notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    gateId: uuid("gate_id").references(() => gates.id, { onDelete: "set null" }),
    actorMemberId: uuid("actor_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    body: text("body"),
    /** 點擊後前往的 Web 路徑或網址。 */
    url: text("url"),
    desktop: boolean("desktop").notNull().default(false),
    readAt: timestamptz("read_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_member_id_created_at_idx").on(t.memberId, t.createdAt),
    index("notifications_member_id_unread_idx").on(t.memberId).where(sql`${t.readAt} IS NULL`),
    index("notifications_member_id_desktop_idx")
      .on(t.memberId, t.createdAt)
      .where(sql`${t.desktop}`),
  ],
);

/**
 * 個人的通知設定。沒有紀錄時全部開啟、沒有勿擾時段。
 * 勿擾時段以當地時間的分鐘數（0–1439）表示，start 大於 end 表示跨午夜；兩者都是 null 表示不設定。
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    memberId: uuid("member_id")
      .primaryKey()
      .references(() => members.id, { onDelete: "cascade" }),
    /** 關閉的事件類型，App 內與桌面都不送。 */
    disabledKinds: notificationKindEnum("disabled_kinds")
      .array()
      .notNull()
      .default(sql`'{}'::notification_kind[]`),
    quietHoursStartMinute: integer("quiet_hours_start_minute"),
    quietHoursEndMinute: integer("quiet_hours_end_minute"),
    /** IANA 時區，例如 `Asia/Taipei`。 */
    timeZone: text("time_zone"),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "notification_preferences_quiet_hours_complete",
      sql`(${t.quietHoursStartMinute} IS NULL) = (${t.quietHoursEndMinute} IS NULL)
        AND (${t.quietHoursStartMinute} IS NULL OR ${t.timeZone} IS NOT NULL)`,
    ),
    check(
      "notification_preferences_quiet_hours_range",
      sql`(${t.quietHoursStartMinute} IS NULL OR ${t.quietHoursStartMinute} BETWEEN 0 AND 1439)
        AND (${t.quietHoursEndMinute} IS NULL OR ${t.quietHoursEndMinute} BETWEEN 0 AND 1439)`,
    ),
  ],
);
