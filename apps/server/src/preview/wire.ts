// Preview 多工通道的常數、控制 frame 與 binary 資料的編解碼（ARCHITECTURE §13）。
//
// TODO(contract): 契約 v2（#29）合併後全部改用 @orbis/protocol 的 PREVIEW_* 常數、
// encodePreviewData／decodePreviewData 與 frame 型別。名稱已照契約分支（contract/w5-7 的
// packages/protocol/src/preview-data.ts、crates/orbis-protocol/src/preview.rs）寫，合併後只需要換 import。

/** 每個 stream 每個方向的初始 credit。Runner 給 Server 的初始 credit 固定是這個值。 */
export const PREVIEW_INITIAL_WINDOW = 256 * 1024;
export const PREVIEW_MAX_CHUNK = 64 * 1024;
export const PREVIEW_DATA_HEADER_LEN = 5;
/** 分段後組回的單則 WebSocket 訊息上限；超過時以 1009 關閉。 */
export const PREVIEW_MAX_WS_MESSAGE = 16 * 1024 * 1024;

export const PREVIEW_DATA_KINDS = { body: 0, ws_text: 1, ws_binary: 2, ws_fragment: 3 } as const;
export type PreviewDataKind = keyof typeof PREVIEW_DATA_KINDS;

export interface PreviewData {
  kind: PreviewDataKind;
  streamId: number;
  payload: Uint8Array;
}

const KIND_BY_BYTE = new Map<number, PreviewDataKind>(
  (Object.entries(PREVIEW_DATA_KINDS) as [PreviewDataKind, number][]).map(([kind, byte]) => [
    byte,
    kind,
  ]),
);

export function encodePreviewData(data: PreviewData): Uint8Array {
  if (data.payload.byteLength > PREVIEW_MAX_CHUNK) {
    throw new RangeError(`preview 資料超過 ${PREVIEW_MAX_CHUNK} byte`);
  }
  const out = new Uint8Array(PREVIEW_DATA_HEADER_LEN + data.payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, PREVIEW_DATA_KINDS[data.kind]);
  view.setUint32(1, data.streamId, false);
  out.set(data.payload, PREVIEW_DATA_HEADER_LEN);
  return out;
}

export function decodePreviewData(bytes: Uint8Array): PreviewData {
  if (bytes.byteLength < PREVIEW_DATA_HEADER_LEN) {
    throw new RangeError("preview 資料比 header 還短");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kindByte = view.getUint8(0);
  const kind = KIND_BY_BYTE.get(kindByte);
  if (kind === undefined) throw new RangeError(`不認得的 preview 資料種類 ${kindByte}`);
  const payload = bytes.subarray(PREVIEW_DATA_HEADER_LEN);
  if (payload.byteLength > PREVIEW_MAX_CHUNK) {
    throw new RangeError(`preview 資料超過 ${PREVIEW_MAX_CHUNK} byte`);
  }
  return { kind, streamId: view.getUint32(1, false), payload };
}

export type PreviewHeaders = [string, string][];

export type PreviewResetReason =
  | "canceled"
  | "upstream_error"
  | "not_running"
  | "too_many_streams"
  | "protocol_error";

/** Server 送給 Runner 的 preview 控制 frame。 */
export type PreviewToRunner =
  | {
      type: "preview_open";
      stream_id: number;
      run_id: string;
      kind: "http" | "websocket";
      method: string;
      path: string;
      headers: PreviewHeaders;
      window: number;
    }
  | { type: "preview_window"; stream_id: number; credit: number }
  | { type: "preview_end"; stream_id: number }
  | { type: "preview_reset"; stream_id: number; reason: PreviewResetReason; message: string }
  | { type: "preview_ws_close"; stream_id: number; code: number; reason: string };

/** Runner 送來的 preview 控制 frame。 */
export type PreviewFromRunner =
  | { type: "preview_response"; stream_id: number; status: number; headers: PreviewHeaders }
  | { type: "preview_window"; stream_id: number; credit: number }
  | { type: "preview_end"; stream_id: number }
  | { type: "preview_reset"; stream_id: number; reason: string; message: string }
  | { type: "preview_ws_close"; stream_id: number; code: number; reason: string };

const FROM_RUNNER_TYPES = new Set([
  "preview_response",
  "preview_window",
  "preview_end",
  "preview_reset",
  "preview_ws_close",
]);

/** 解析 Runner 送來的 JSON；不是 preview frame 時回傳 null，格式錯誤時回傳 "invalid"。 */
export function parsePreviewFrame(value: unknown): PreviewFromRunner | "invalid" | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== "string" || !v.type.startsWith("preview_")) return null;
  if (!FROM_RUNNER_TYPES.has(v.type)) return "invalid";
  if (typeof v.stream_id !== "number" || !Number.isInteger(v.stream_id)) return "invalid";
  switch (v.type) {
    case "preview_response":
      if (typeof v.status !== "number" || !Array.isArray(v.headers)) return "invalid";
      if (
        !v.headers.every(
          (h) => Array.isArray(h) && h.length === 2 && h.every((s) => typeof s === "string"),
        )
      ) {
        return "invalid";
      }
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
