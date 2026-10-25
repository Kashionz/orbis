// Event（ARCHITECTURE §14）：Run 過程中由 Runner 正規化後送到 Server 的一筆紀錄。
// Server 推送與重播給 Web 時使用這個外層。
//
// 外層欄位是 REST 的 camelCase；`event` 是 Rust 協定定義的 EventKind，原樣保留協定的
// 形狀（snake_case、以 `kind` 區分），Server 不做轉換。Web 直接以 `event.kind` 縮小型別，
// 使用 @orbis/protocol 的型別渲染。

import { EVENT_KINDS, type EventKind } from "@orbis/protocol";
import { z } from "zod";
import { Id, Timestamp } from "./common";

export { EVENT_KINDS };

export const EventKindName = z.enum(EVENT_KINDS);
export type EventKindName = z.infer<typeof EventKindName>;

/**
 * Event 的內容。只檢查是物件且 `kind` 是已知的值；各 kind 的欄位由協定保證
 * （Runner 送出前已經過 Rust 型別序列化），這裡不重複驗證。
 */
export const RunEventBody = z.custom<EventKind>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    EventKindName.safeParse((value as { kind?: unknown }).kind).success,
  { error: "Event 內容必須是帶有已知 kind 的物件" },
);

export const RunEvent = z.object({
  runId: Id,
  /** 在每個 Run 內從 1 開始連續遞增。 */
  seq: z.number().int().positive(),
  ts: Timestamp,
  event: RunEventBody,
  /**
   * 觸發這筆 Event 的人（API 版本 2）：`prompt_submitted` 是送出 prompt 的人、`permission_resolved` 是回覆的人，
   * 由 Event 的 `control_id` 對應到送出 RunControl 的 Member；Run 的第一個 prompt 是派工的人。
   * 其他 Event、系統觸發的 prompt、舊的 Event（沒有 `control_id`）為 null。
   */
  actorMemberId: Id.nullable(),
});
export type RunEvent = z.infer<typeof RunEvent>;
