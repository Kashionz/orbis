// 通知中心、桌面通知 feed 與個人的通知設定（ARCHITECTURE §12.3）。每個人只看得到自己的通知。
//
// - 通知依 id 排序：id 是 UUIDv7，與建立順序一致。
// - 桌面 feed：Electron 第一次輪詢不帶 `after`，只拿 `cursor` 作為基準；之後以上一次的 `cursor` 取得新的
//   `desktop = true` 通知（已套用個人設定與勿擾時段）。還沒有任何通知時 cursor 是 `NO_NOTIFICATIONS`。
// - 列出時依目前的 Task 可見性（ADR-0012）濾掉看不到的 Task 的通知：Task 之後改成僅受邀成員、或人被移出
//   Task 時，舊通知的標題與內容不再出現。分頁與 cursor 仍依原本的列，可能有某一頁比 limit 少。

import {
  API_ROUTES,
  MarkNotificationsReadInput,
  type NotificationDesktopFeed,
  type NotificationListResponse,
  NotificationPreferences,
} from "@orbis/api-contract";
import { and, asc, desc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { visibleTaskIds } from "../authz/task-access";
import { notificationPreferences, notifications, tasks } from "../db/schema";
import type { Executor } from "../db/tx";
import { toNotification } from "../http/dto";
import { readJson, readQuery } from "../http/errors";
import type { Actor, AppEnv } from "../http/session";
import type { Services } from "../services";

const NO_NOTIFICATIONS = "none";

const ListQuery = z.object({
  unreadOnly: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const FeedQuery = z.object({
  after: z.union([z.uuid(), z.literal(NO_NOTIFICATIONS)]).optional(),
});

const toMinutes = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const toTime = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

type NotificationRow = typeof notifications.$inferSelect;

/** 只留下沒有 Task、或 Actor 目前看得到那個 Task 的通知。 */
async function visibleOnly<T extends { taskId: string | null }>(
  db: Executor,
  actor: Actor,
  rows: T[],
): Promise<T[]> {
  const visible = await visibleTaskIds(
    db,
    actor,
    rows.flatMap((r) => (r.taskId ? [r.taskId] : [])),
  );
  return rows.filter((r) => r.taskId === null || visible.has(r.taskId));
}

async function withTaskKeys(db: Executor, rows: NotificationRow[]) {
  const taskIds = [...new Set(rows.flatMap((r) => (r.taskId ? [r.taskId] : [])))];
  const keys =
    taskIds.length > 0
      ? await db
          .select({ id: tasks.id, key: tasks.key })
          .from(tasks)
          .where(inArray(tasks.id, taskIds))
      : [];
  const byId = new Map(keys.map((k) => [k.id, k.key]));
  return rows.map((row) => toNotification(row, row.taskId ? (byId.get(row.taskId) ?? null) : null));
}

export function createNotificationRoutes(s: Services): Hono<AppEnv> {
  const { db, auth } = s;
  const app = new Hono<AppEnv>();

  app.get(API_ROUTES.notifications, auth, async (c) => {
    const actor = c.get("actor");
    const query = readQuery(c, ListQuery);
    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.memberId, actor.memberId),
          query.unreadOnly ? isNull(notifications.readAt) : undefined,
          query.before ? lt(notifications.id, query.before) : undefined,
        ),
      )
      .orderBy(desc(notifications.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const response: NotificationListResponse = {
      items: await withTaskKeys(db, await visibleOnly(db, actor, page)),
      nextBefore: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
    return c.json(response);
  });

  app.get(API_ROUTES.notificationsUnreadCount, auth, async (c) => {
    const actor = c.get("actor");
    const unread = await db
      .select({ taskId: notifications.taskId })
      .from(notifications)
      .where(and(eq(notifications.memberId, actor.memberId), isNull(notifications.readAt)));
    return c.json({ count: (await visibleOnly(db, actor, unread)).length });
  });

  app.post(API_ROUTES.notificationsRead, auth, async (c) => {
    const actor = c.get("actor");
    const input = await readJson(c, MarkNotificationsReadInput);
    await db
      .update(notifications)
      .set({ readAt: s.clock.now() })
      .where(
        and(
          eq(notifications.memberId, actor.memberId),
          isNull(notifications.readAt),
          "ids" in input ? inArray(notifications.id, input.ids) : undefined,
        ),
      );
    return c.body(null, 204);
  });

  app.get(API_ROUTES.notificationsDesktopFeed, auth, async (c) => {
    const actor = c.get("actor");
    const { after } = readQuery(c, FeedQuery);
    if (after === undefined) {
      const [latest] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.memberId, actor.memberId))
        .orderBy(desc(notifications.id))
        .limit(1);
      const response: NotificationDesktopFeed = {
        items: [],
        cursor: latest?.id ?? NO_NOTIFICATIONS,
      };
      return c.json(response);
    }
    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.memberId, actor.memberId),
          eq(notifications.desktop, true),
          after === NO_NOTIFICATIONS ? undefined : gt(notifications.id, after),
        ),
      )
      .orderBy(asc(notifications.id))
      .limit(100);
    const response: NotificationDesktopFeed = {
      items: await withTaskKeys(db, await visibleOnly(db, actor, rows)),
      cursor: rows.at(-1)?.id ?? after,
    };
    return c.json(response);
  });

  app.get(API_ROUTES.notificationPreferences, auth, async (c) => {
    const actor = c.get("actor");
    const [row] = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.memberId, actor.memberId));
    return c.json(toPreferences(row));
  });

  app.put(API_ROUTES.notificationPreferences, auth, async (c) => {
    const actor = c.get("actor");
    const input = await readJson(c, NotificationPreferences);
    const values = {
      disabledKinds: [...new Set(input.disabledKinds)],
      quietHoursStartMinute: input.quietHours ? toMinutes(input.quietHours.start) : null,
      quietHoursEndMinute: input.quietHours ? toMinutes(input.quietHours.end) : null,
      timeZone: input.quietHours?.timeZone ?? null,
    };
    const [row] = await db
      .insert(notificationPreferences)
      .values({ memberId: actor.memberId, ...values })
      .onConflictDoUpdate({ target: notificationPreferences.memberId, set: values })
      .returning();
    return c.json(toPreferences(row));
  });

  return app;
}

function toPreferences(
  row: typeof notificationPreferences.$inferSelect | undefined,
): NotificationPreferences {
  return {
    disabledKinds: row?.disabledKinds ?? [],
    quietHours:
      row && row.quietHoursStartMinute !== null && row.quietHoursEndMinute !== null && row.timeZone
        ? {
            start: toTime(row.quietHoursStartMinute),
            end: toTime(row.quietHoursEndMinute),
            timeZone: row.timeZone,
          }
        : null,
  };
}
