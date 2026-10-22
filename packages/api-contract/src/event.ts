// Event（ARCHITECTURE §14）：Run 過程中由 Runner 正規化後送到 Server 的一筆紀錄。
// Server 推送與重播給 Web 時使用這個外層；kind 與 payload 的定義來源是 Rust 協定。

import { z } from "zod";
import { Id, Timestamp } from "./common";

export const RunEvent = z.object({
  runId: Id,
  /** 在每個 Run 內從 1 開始遞增。 */
  seq: z.number().int().positive(),
  ts: Timestamp,
  // TODO(contract): 合併 W1 後改用 @orbis/protocol 的 EventKind
  kind: z.string().min(1),
  // TODO(contract): 合併 W1 後改用 @orbis/protocol 的 EventKind 對應的 payload 型別
  payload: z.unknown(),
});
export type RunEvent = z.infer<typeof RunEvent>;
