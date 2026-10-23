// Web 的即時推送（WebSocket `API_ROUTES.ws`，ARCHITECTURE §12.3）：Run 的 Event（需要訂閱），
// 以及給登入者的通知（不需要訂閱，送到該 Member 的所有連線）。看板與 Needs You 以輪詢更新。
//
// Server 在 `subscribe_run` 後，先從 DB 重播 `afterSeq` 之後已保存的 Event，再接上即時串流，
// 保證不漏、不重。

import { z } from "zod";
import { Id } from "./common";
import { RunEvent } from "./event";
import { Notification } from "./notification";

/** Web → Server。 */
export const WebClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe_run"),
    runId: Id,
    /** 從這個 seq 之後開始送（不含）；0 表示從頭重播。 */
    afterSeq: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("unsubscribe_run"), runId: Id }),
]);
export type WebClientMessage = z.infer<typeof WebClientMessage>;

/** 每條連線最多同時訂閱的 Run 數；超過時回 `limit_exceeded`。 */
export const WEB_WS_MAX_SUBSCRIPTIONS = 50;

export const WEB_WS_ERROR_CODES = [
  "invalid_message",
  "not_found",
  "forbidden",
  "limit_exceeded",
] as const;

/** Server → Web。 */
export const WebServerMessage = z.discriminatedUnion("type", [
  /** 一批依 seq 排序、連續的 Event；重播時一次送多筆，即時推送時通常一筆。 */
  z.object({ type: z.literal("run_events"), runId: Id, events: z.array(RunEvent).min(1) }),
  /** 新的 App 內通知（已套用個人設定）。Web 據此更新通知中心與未讀數。 */
  z.object({ type: z.literal("notification"), notification: Notification }),
  z.object({
    type: z.literal("error"),
    code: z.enum(WEB_WS_ERROR_CODES),
    message: z.string(),
    /** 與某個 Run 有關的錯誤（例如沒有權限訂閱）；與連線本身有關時為 null。 */
    runId: Id.nullable(),
  }),
]);
export type WebServerMessage = z.infer<typeof WebServerMessage>;
