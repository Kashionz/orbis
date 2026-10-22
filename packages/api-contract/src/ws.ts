// Web 的即時推送（WebSocket `API_ROUTES.ws`）。Phase 1 只推 Run 的 Event（ARCHITECTURE §12.3）；
// 看板與 Needs You 以輪詢更新。
//
// Server 在 `subscribe_run` 後，先從 DB 重播 `afterSeq` 之後已保存的 Event，再接上即時串流，
// 保證不漏、不重。

import { z } from "zod";
import { Id } from "./common";
import { RunEvent } from "./event";

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

export const WEB_WS_ERROR_CODES = ["invalid_message", "not_found", "forbidden"] as const;

/** Server → Web。 */
export const WebServerMessage = z.discriminatedUnion("type", [
  /** 一批依 seq 排序、連續的 Event；重播時一次送多筆，即時推送時通常一筆。 */
  z.object({ type: z.literal("run_events"), runId: Id, events: z.array(RunEvent).min(1) }),
  z.object({
    type: z.literal("error"),
    code: z.enum(WEB_WS_ERROR_CODES),
    message: z.string(),
    /** 與某個 Run 有關的錯誤（例如沒有權限訂閱）；與連線本身有關時為 null。 */
    runId: Id.nullable(),
  }),
]);
export type WebServerMessage = z.infer<typeof WebServerMessage>;
