// 通知（ARCHITECTURE §12.3）。Server 先套用個人設定，再交給各 Channel：
// - `in_app`：存進通知中心；Web 經由 `/api/ws` 的 `notification` 即時收到。
// - `desktop`：Electron 每 5 秒輪詢桌面 feed，發出原生通知。
//
// 依事件類型關閉＝兩個 Channel 都不送。勿擾時段只抑制桌面推送，App 內照常記錄，結束後也不補推。

import { z } from "zod";
import { AppPath, Id, Timestamp } from "./common";
import { NotificationKind } from "./enums";
import { StoppedRunInfo } from "./needs-you";
import { TaskKey } from "./task";

export const Notification = z.object({
  id: Id,
  kind: NotificationKind,
  taskId: Id.nullable(),
  /** 方便 UI 直接顯示，不必另外查 Task。 */
  taskKey: TaskKey.nullable(),
  runId: Id.nullable(),
  gateId: Id.nullable(),
  /** 觸發的人；系統觸發時為 null。 */
  actorMemberId: Id.nullable(),
  title: z.string().min(1),
  body: z.string().nullable(),
  /** 點擊後前往的站內路徑，例如 `/tasks/ORB-12`。 */
  url: AppPath.nullable(),
  /**
   * `run_stopped` 的原因（API 版本 2），Web 依代碼在地化；其他種類為 null。
   * `title`／`body` 仍是 Server 產生的文字，給桌面通知使用。
   */
  stoppedRun: StoppedRunInfo.nullable(),
  /** 已讀的時間；未讀時為 null。 */
  readAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Notification = z.infer<typeof Notification>;

/** `GET` notifications 的回應，依時間排序（新的在前）。查詢參數：`unreadOnly`、`before`（ID）、`limit`。 */
export const NotificationListResponse = z.object({
  items: z.array(Notification),
  /** 還有更舊的通知時，下一頁的 `before`；沒有時為 null。 */
  nextBefore: Id.nullable(),
});
export type NotificationListResponse = z.infer<typeof NotificationListResponse>;

/** `GET` notificationsUnreadCount 的回應。 */
export const NotificationUnreadCount = z.object({ count: z.number().int().nonnegative() });
export type NotificationUnreadCount = z.infer<typeof NotificationUnreadCount>;

/** 標為已讀（`POST` notificationsRead）：指定的通知，或全部。 */
export const MarkNotificationsReadInput = z.union([
  z.object({ ids: z.array(Id).min(1).max(500) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
export type MarkNotificationsReadInput = z.infer<typeof MarkNotificationsReadInput>;

/**
 * `GET` notificationsDesktopFeed 的回應（Electron 輪詢，查詢參數 `after`）。只包含要推送到桌面的通知
 * （已套用個人設定與勿擾時段），依時間排序（舊的在前）。第一次輪詢不帶 `after`，只回傳 `cursor`
 * 作為基準、`items` 為空陣列，之後以上一次的 `cursor` 查詢。
 */
export const NotificationDesktopFeed = z.object({
  items: z.array(Notification),
  /** 下一次輪詢的 `after`，格式由 Server 決定。 */
  cursor: z.string().min(1),
});
export type NotificationDesktopFeed = z.infer<typeof NotificationDesktopFeed>;

/** 一天中的時間，`HH:MM`（24 小時制）。 */
export const TimeOfDay = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, {
  error: "時間的格式必須是 HH:MM",
});

/** IANA 時區名稱，例如 `Asia/Taipei`。 */
export const TimeZone = z.string().refine(
  (zone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  },
  { error: "不是合法的 IANA 時區" },
);

/** 勿擾時段。`start` 晚於 `end` 表示跨午夜（例如 22:00–08:00）；兩者相同視為不設定。 */
export const QuietHours = z
  .object({ start: TimeOfDay, end: TimeOfDay, timeZone: TimeZone })
  .strict()
  .refine((q) => q.start !== q.end, { error: "開始與結束的時間不能相同", path: ["end"] });
export type QuietHours = z.infer<typeof QuietHours>;

/** 個人的通知設定（`GET`／`PUT` notificationPreferences）。 */
export const NotificationPreferences = z
  .object({
    /** 關閉的事件類型，兩個 Channel 都不送。 */
    disabledKinds: z.array(NotificationKind),
    /** 勿擾時段；不設定時為 null。 */
    quietHours: QuietHours.nullable(),
  })
  .strict();
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;
