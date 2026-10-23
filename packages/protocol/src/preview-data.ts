// Preview 通道的 binary 訊息（crates/orbis-protocol/src/preview.rs 的 TS 版）。
//
// 格式：`[kind u8][stream_id u32 big-endian][payload]`。ts-rs 只產生型別，所以編解碼在這裡手寫；
// 與 Rust 共用 `crates/orbis-protocol/tests/preview_data.json` 的 golden case，兩邊的測試都會檢查。

import { PREVIEW_DATA_HEADER_LEN, PREVIEW_DATA_KINDS, PREVIEW_MAX_CHUNK } from "./generated/index";

export type PreviewDataKind = keyof typeof PREVIEW_DATA_KINDS;

export interface PreviewData {
  kind: PreviewDataKind;
  /** 0 到 2^32 - 1。 */
  streamId: number;
  payload: Uint8Array;
}

const KIND_BY_BYTE = new Map<number, PreviewDataKind>(
  (Object.entries(PREVIEW_DATA_KINDS) as [PreviewDataKind, number][]).map(([kind, byte]) => [
    byte,
    kind,
  ]),
);

/** 編碼成一則 binary 訊息。payload 超過 `PREVIEW_MAX_CHUNK` 時要先切開。 */
export function encodePreviewData(data: PreviewData): Uint8Array {
  if (data.payload.byteLength > PREVIEW_MAX_CHUNK) {
    throw new RangeError(`preview 資料超過 ${PREVIEW_MAX_CHUNK} byte`);
  }
  if (!Number.isInteger(data.streamId) || data.streamId < 0 || data.streamId > 0xffff_ffff) {
    throw new RangeError(`stream_id 必須是 u32：${data.streamId}`);
  }
  const out = new Uint8Array(PREVIEW_DATA_HEADER_LEN + data.payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, PREVIEW_DATA_KINDS[data.kind]);
  view.setUint32(1, data.streamId, false);
  out.set(data.payload, PREVIEW_DATA_HEADER_LEN);
  return out;
}

/** 解析一則 binary 訊息。payload 是原本 buffer 的 view，不複製。格式不對時丟出錯誤。 */
export function decodePreviewData(bytes: Uint8Array): PreviewData {
  if (bytes.byteLength < PREVIEW_DATA_HEADER_LEN) {
    throw new RangeError("preview 資料比 header 還短");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kindByte = view.getUint8(0);
  const kind = KIND_BY_BYTE.get(kindByte);
  if (kind === undefined) {
    throw new RangeError(`不認得的 preview 資料種類 ${kindByte}`);
  }
  const payload = bytes.subarray(PREVIEW_DATA_HEADER_LEN);
  if (payload.byteLength > PREVIEW_MAX_CHUNK) {
    throw new RangeError(`preview 資料超過 ${PREVIEW_MAX_CHUNK} byte`);
  }
  return { kind, streamId: view.getUint32(1, false), payload };
}
