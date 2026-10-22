// Server↔Web 共用的基本型別。REST JSON 一律 camelCase；ID 是字串，時間是 ISO 8601 字串。

import { z } from "zod";

/** 資源 ID。Server 產生 UUID v7，但契約只要求是非空字串，不檢查 UUID 格式。 */
export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

/** ISO 8601 的 UTC 時間字串，例如 `2026-10-23T08:00:00.000Z`（與協定的 Timestamp 相同格式）。 */
export const Timestamp = z.iso.datetime();
export type Timestamp = z.infer<typeof Timestamp>;
