// Preview 多工通道的訊息（ARCHITECTURE §13）：協定的常數、binary 資料的編解碼與 preview frame。

import type { RunnerToServer, ServerToRunner } from "@orbis/protocol";

export {
  decodePreviewData,
  encodePreviewData,
  PREVIEW_DATA_HEADER_LEN,
  PREVIEW_INITIAL_WINDOW,
  PREVIEW_MAX_CHUNK,
  PREVIEW_MAX_WS_MESSAGE,
  type PreviewData,
  type PreviewDataKind,
} from "@orbis/protocol";

export type PreviewHeaders = [string, string][];

type PreviewType = `preview_${string}`;

/** Server 送給 Runner 的 preview 控制 frame。 */
export type PreviewToRunner = Extract<ServerToRunner, { type: PreviewType }>;

/** Runner 送來的 preview 控制 frame。 */
export type PreviewFromRunner = Extract<RunnerToServer, { type: PreviewType }>;

const FROM_RUNNER_TYPES = new Set([
  "preview_response",
  "preview_window",
  "preview_end",
  "preview_reset",
  "preview_ws_close",
]);

const isHeaders = (value: unknown): value is PreviewHeaders =>
  Array.isArray(value) &&
  value.every((h) => Array.isArray(h) && h.length === 2 && h.every((s) => typeof s === "string"));

/** 解析 Runner 送來的 JSON；不是 preview frame 時回傳 null，格式錯誤時回傳 "invalid"。 */
export function parsePreviewFrame(value: unknown): PreviewFromRunner | "invalid" | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== "string" || !v.type.startsWith("preview_")) return null;
  if (!FROM_RUNNER_TYPES.has(v.type)) return "invalid";
  if (typeof v.stream_id !== "number" || !Number.isInteger(v.stream_id)) return "invalid";
  switch (v.type) {
    case "preview_response":
      if (typeof v.status !== "number" || !isHeaders(v.headers)) return "invalid";
      break;
    case "preview_window":
      if (typeof v.credit !== "number" || v.credit < 0) return "invalid";
      break;
    case "preview_ws_close":
      if (typeof v.code !== "number" || typeof v.reason !== "string") return "invalid";
      break;
    case "preview_reset":
      if (typeof v.reason !== "string" || typeof v.message !== "string") return "invalid";
      break;
  }
  return value as PreviewFromRunner;
}
