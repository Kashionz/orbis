// Preview 的轉送（ARCHITECTURE §13「轉送」、ADR-0010）：Preview 網址的每個 HTTP 請求或 WebSocket
// 是一條 stream，經由執行這個 Run 的 Runner 的連線多工送給 Runner，Runner 再轉給 dev server。
//
// - 控制用 JSON frame，資料用 binary 訊息（wire.ts）。
// - 背壓：送給 Runner 的資料最多送出 Runner 給的 credit；Runner 送來的資料交給瀏覽器（HTTP 回應被
//   讀走、WebSocket 送出）之後才補 credit。HTTP 回應的 body 是 pull 式的 ReadableStream，
//   瀏覽器讀得慢時 Server 不再補 credit，Runner 也就停下來。

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { eq } from "drizzle-orm";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import type { Database } from "../db/client";
import { runs } from "../db/schema";
import { TERMINAL_RUN_STATUSES } from "../domain/run-status";
import type { Logger } from "../logger";
import type { RunnerPreviewChannel } from "../runner/endpoint";
import type { RunnerHub, RunnerLink } from "../runner/hub";
import type { PreviewRelay } from "./host";
import {
  decodePreviewData,
  encodePreviewData,
  PREVIEW_INITIAL_WINDOW,
  PREVIEW_MAX_CHUNK,
  PREVIEW_MAX_WS_MESSAGE,
  type PreviewDataKind,
  type PreviewFromRunner,
  type PreviewHeaders,
  type PreviewToRunner,
  parsePreviewFrame,
} from "./wire";

/** 等 Runner 回覆 WebSocket 交握的時間。 */
const WS_ACCEPT_TIMEOUT_MS = 15_000;
/** 回應不可以有 body 的狀態碼。 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
/** 轉送時不帶過去的 hop-by-hop header（RFC 9110 §7.6.1）。 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface PreviewRelayDeps {
  db: Database;
  hub: RunnerHub;
  logger: Logger;
  /** Preview 網址的 scheme（`X-Forwarded-Proto`）。 */
  scheme: "http" | "https";
}

/** 轉送給 Runner 的請求 header：移除 hop-by-hop 與請求自己帶的 X-Forwarded-*，加上 X-Forwarded-Proto。 */
export function requestHeaders(
  entries: Iterable<[string, string]>,
  scheme: "http" | "https",
  websocket: boolean,
): PreviewHeaders {
  const out: PreviewHeaders = [];
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower.startsWith("x-forwarded-") || lower === "forwarded") {
      continue;
    }
    // WebSocket 交握的 header 由 Runner 連 dev server 時自己產生
    if (websocket && lower.startsWith("sec-websocket-") && lower !== "sec-websocket-protocol") {
      continue;
    }
    out.push([lower, value]);
  }
  out.push(["x-forwarded-proto", scheme]);
  return out;
}

/** `Set-Cookie` 移除 Domain 屬性：dev server 的 cookie 只屬於這個 Preview 網址。 */
export function hostOnlyCookie(value: string): string {
  return value
    .split(";")
    .filter((part) => !/^\s*domain\s*=/i.test(part))
    .join(";");
}

/** 轉回給瀏覽器的回應 header。 */
export function responseHeaders(headers: PreviewHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    try {
      out.append(name, lower === "set-cookie" ? hostOnlyCookie(value) : value);
    } catch {
      // 不合法的 header 略過
    }
  }
  return out;
}

function errorPage(status: number, message: string): Response {
  const escaped = message.replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch,
  );
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Preview 目前無法使用</title></head>` +
      `<body style="font:16px sans-serif;padding:2rem"><h1>Preview 目前無法使用</h1><p>${escaped}</p></body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

interface Channel {
  link: RunnerLink;
  streams: Map<number, Stream>;
  nextId: number;
}

export class PreviewRelayService implements PreviewRelay, RunnerPreviewChannel {
  private readonly channels = new Map<RunnerLink, Channel>();

  constructor(private readonly deps: PreviewRelayDeps) {}

  // ---- Runner 連線（runner/endpoint.ts 呼叫） ----

  onMessage(_runnerId: string, link: RunnerLink, data: RawData, isBinary: boolean): boolean {
    const channel = this.channels.get(link);
    if (isBinary) {
      if (!channel) return true;
      let decoded: ReturnType<typeof decodePreviewData>;
      try {
        decoded = decodePreviewData(toBytes(data));
      } catch (error) {
        this.deps.logger.debug({ err: error }, "無法解析的 preview 資料，略過");
        return true;
      }
      channel.streams.get(decoded.streamId)?.onData(decoded.kind, decoded.payload);
      return true;
    }
    let json: unknown;
    try {
      json = JSON.parse(toBytes(data).toString());
    } catch {
      return false;
    }
    const frame = parsePreviewFrame(json);
    if (frame === null) return false;
    if (frame === "invalid") {
      this.deps.logger.warn("preview frame 格式不正確，略過");
      return true;
    }
    channel?.streams.get(frame.stream_id)?.onFrame(frame);
    return true;
  }

  onDisconnect(_runnerId: string, link: RunnerLink): void {
    const channel = this.channels.get(link);
    if (!channel) return;
    this.channels.delete(link);
    for (const stream of [...channel.streams.values()]) {
      stream.fail("執行這個 Run 的 Runner 已斷線");
    }
  }

  // ---- Preview 網址（host.ts 呼叫） ----

  async fetch(runId: string, request: Request): Promise<Response> {
    const target = await this.channelFor(runId);
    if ("error" in target) return errorPage(503, target.error);
    const url = new URL(request.url);
    const stream = new HttpStream(target.channel, this.allocate(target.channel), request.method);
    stream.send({
      type: "preview_open",
      stream_id: stream.id,
      run_id: runId,
      kind: "http",
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: requestHeaders(request.headers.entries(), this.deps.scheme, false),
      window: PREVIEW_INITIAL_WINDOW,
    });
    request.signal.addEventListener("abort", () => stream.cancel(), { once: true });
    void stream.pumpRequest(request.body);
    return stream.response;
  }

  upgrade(runId: string, request: IncomingMessage, socket: Duplex, head: Buffer): void {
    void this.upgradeAsync(runId, request, socket, head).catch((error: unknown) => {
      this.deps.logger.warn({ err: error, runId }, "Preview 的 WebSocket 轉送失敗");
      socket.destroy();
    });
  }

  private async upgradeAsync(
    runId: string,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const target = await this.channelFor(runId);
    if ("error" in target) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    // 用 request.headers（host.ts 已移除 preview cookie），不用 rawHeaders（還帶著原本的 cookie）
    const pairs: [string, string][] = [];
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) pairs.push([name, v]);
    }
    const stream = new WsStream(target.channel, this.allocate(target.channel));
    stream.send({
      type: "preview_open",
      stream_id: stream.id,
      run_id: runId,
      kind: "websocket",
      method: "GET",
      path: request.url ?? "/",
      headers: requestHeaders(pairs, this.deps.scheme, true),
      window: PREVIEW_INITIAL_WINDOW,
    });
    const onEarlyClose = () => stream.cancel();
    socket.once("close", onEarlyClose);
    const accepted = await stream.accepted(WS_ACCEPT_TIMEOUT_MS);
    socket.off("close", onEarlyClose);
    if (!accepted.ok) {
      socket.end(
        `HTTP/1.1 ${accepted.status} Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    const protocol = accepted.headers.find(
      ([name]) => name.toLowerCase() === "sec-websocket-protocol",
    )?.[1];
    const wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: PREVIEW_MAX_WS_MESSAGE,
      handleProtocols: () => protocol ?? false,
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      stream.attach(ws);
      wss.close();
    });
  }

  private async channelFor(runId: string): Promise<{ channel: Channel } | { error: string }> {
    const [run] = await this.deps.db
      .select({ runnerId: runs.runnerId, status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run?.runnerId || TERMINAL_RUN_STATUSES.includes(run.status)) {
      return { error: "這個 Run 已經結束或還沒開始執行，Preview 目前不提供。" };
    }
    const link = this.deps.hub.link(run.runnerId);
    if (!link?.sendRaw) return { error: "執行這個 Run 的 Runner 目前離線。" };
    let channel = this.channels.get(link);
    if (!channel) {
      channel = { link, streams: new Map(), nextId: 1 };
      this.channels.set(link, channel);
    }
    return { channel };
  }

  private allocate(channel: Channel): number {
    while (channel.streams.has(channel.nextId)) channel.nextId = (channel.nextId % 0xffff_ffff) + 1;
    const id = channel.nextId;
    channel.nextId = (channel.nextId % 0xffff_ffff) + 1;
    return id;
  }
}

function toBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return data;
}

/** 一條 stream 的共用部分：送訊息、兩個方向的 credit。 */
abstract class Stream {
  /** 還能送給 Runner 的 byte 數。Runner 給 Server 的初始 credit 固定是 PREVIEW_INITIAL_WINDOW。 */
  private outCredit = PREVIEW_INITIAL_WINDOW;
  /** Runner 還能送來的 byte 數（Server 給的 credit）。 */
  private inCredit = PREVIEW_INITIAL_WINDOW;
  private creditWaiters: (() => void)[] = [];
  protected closed = false;

  constructor(
    protected readonly channel: Channel,
    readonly id: number,
  ) {
    channel.streams.set(id, this);
  }

  send(frame: PreviewToRunner): void {
    if (this.closed && frame.type !== "preview_reset") return;
    this.channel.link.sendRaw?.(JSON.stringify(frame));
  }

  abstract onFrame(frame: PreviewFromRunner): void;
  abstract onData(kind: PreviewDataKind, payload: Uint8Array): void;
  /** Runner 斷線或中止：結束這條 stream。 */
  abstract fail(message: string): void;

  /** 使用者端取消：通知 Runner 中止。 */
  cancel(): void {
    if (this.closed) return;
    this.send({ type: "preview_reset", stream_id: this.id, reason: "canceled", message: "" });
    this.finish();
  }

  protected finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.streams.delete(this.id);
    this.wake();
  }

  protected onWindow(credit: number): void {
    this.outCredit += credit;
    this.wake();
  }

  private wake(): void {
    const waiters = this.creditWaiters;
    this.creditWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Runner 送來的資料：檢查沒有超過 credit。 */
  protected received(length: number): boolean {
    this.inCredit -= length;
    if (this.inCredit >= 0) return true;
    this.send({
      type: "preview_reset",
      stream_id: this.id,
      reason: "protocol_error",
      message: "送來的資料超過 credit",
    });
    this.fail("Runner 送來的資料超過 credit");
    return false;
  }

  /** 資料已經交給瀏覽器：補 credit 給 Runner。 */
  protected grant(length: number): void {
    if (length === 0 || this.closed) return;
    this.inCredit += length;
    this.send({ type: "preview_window", stream_id: this.id, credit: length });
  }

  /**
   * 送資料給 Runner，依 credit 與 chunk 上限切開；最後一段是 `lastKind`，前面各段是 `moreKind`。
   * 回傳 false 表示 stream 已經結束。
   */
  protected async sendData(
    moreKind: PreviewDataKind,
    lastKind: PreviewDataKind,
    data: Uint8Array,
  ): Promise<boolean> {
    let offset = 0;
    for (;;) {
      if (this.closed) return false;
      const remaining = data.byteLength - offset;
      if (remaining > 0 && this.outCredit <= 0) {
        await new Promise<void>((resolve) => this.creditWaiters.push(resolve));
        continue;
      }
      const size = Math.min(remaining, PREVIEW_MAX_CHUNK, this.outCredit);
      const last = offset + size === data.byteLength;
      this.channel.link.sendRaw?.(
        encodePreviewData({
          kind: last ? lastKind : moreKind,
          streamId: this.id,
          payload: data.subarray(offset, offset + size),
        }),
      );
      this.outCredit -= size;
      offset += size;
      if (last) return true;
    }
  }
}

class HttpStream extends Stream {
  readonly response: Promise<Response>;
  private resolveResponse!: (response: Response) => void;
  private responded = false;
  private readonly chunks: Uint8Array[] = [];
  private ended = false;
  private failure: Error | null = null;
  private puller: {
    controller: ReadableStreamDefaultController<Uint8Array>;
    done: () => void;
  } | null = null;

  constructor(
    channel: Channel,
    id: number,
    private readonly method: string,
  ) {
    super(channel, id);
    this.response = new Promise((resolve) => {
      this.resolveResponse = resolve;
    });
  }

  /** 把瀏覽器的 request body 送給 Runner，送完以 preview_end 結束。 */
  async pumpRequest(body: ReadableStream<Uint8Array> | null): Promise<void> {
    if (body) {
      const reader = body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!(await this.sendData("body", "body", value))) return;
        }
      } catch {
        this.cancel();
        return;
      }
    }
    this.send({ type: "preview_end", stream_id: this.id });
  }

  onFrame(frame: PreviewFromRunner): void {
    switch (frame.type) {
      case "preview_response":
        this.respond(frame.status, frame.headers);
        return;
      case "preview_window":
        this.onWindow(frame.credit);
        return;
      case "preview_end":
        this.ended = true;
        this.flush();
        return;
      case "preview_reset":
        this.fail(frame.message || "dev server 沒有回應");
        return;
      case "preview_ws_close":
        return;
    }
  }

  onData(kind: PreviewDataKind, payload: Uint8Array): void {
    if (kind !== "body" || !this.responded) {
      this.send({
        type: "preview_reset",
        stream_id: this.id,
        reason: "protocol_error",
        message: "HTTP stream 收到非 body 的資料",
      });
      this.fail("Runner 送來的資料格式不正確");
      return;
    }
    if (!this.received(payload.byteLength)) return;
    // payload 是收到的 buffer 的 view，複製一份交給 ReadableStream
    this.chunks.push(Uint8Array.from(payload));
    this.flush();
  }

  fail(message: string): void {
    if (!this.responded) {
      this.responded = true;
      this.resolveResponse(errorPage(502, message));
    } else {
      this.failure = new Error(message);
      this.flush();
    }
    this.finish();
  }

  private respond(status: number, headers: PreviewHeaders): void {
    if (this.responded) return;
    this.responded = true;
    const noBody = NULL_BODY_STATUSES.has(status) || this.method === "HEAD";
    const body = noBody
      ? null
      : new ReadableStream<Uint8Array>(
          {
            // 瀏覽器（經由 node 的 response）要下一段時才交出資料並補 credit
            pull: (controller) =>
              new Promise<void>((done) => {
                this.puller = { controller, done };
                this.flush();
              }),
            cancel: () => this.cancel(),
          },
          { highWaterMark: 0 },
        );
    try {
      this.resolveResponse(new Response(body, { status, headers: responseHeaders(headers) }));
    } catch {
      this.resolveResponse(errorPage(502, `dev server 回應了不合法的狀態碼 ${status}`));
    }
  }

  private flush(): void {
    const puller = this.puller;
    if (!puller) return;
    if (this.failure) {
      this.puller = null;
      puller.controller.error(this.failure);
      puller.done();
      return;
    }
    const chunk = this.chunks.shift();
    if (chunk) {
      this.puller = null;
      puller.controller.enqueue(chunk);
      this.grant(chunk.byteLength);
      puller.done();
      return;
    }
    if (this.ended) {
      this.puller = null;
      puller.controller.close();
      puller.done();
      this.finish();
    }
  }
}

type Accepted = { ok: true; headers: PreviewHeaders } | { ok: false; status: number };

/** WebSocket close reason 的上限是 123 bytes（UTF-8），依字元截斷，不切開多 byte 的字。 */
export function closeReason(text: string): string {
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > 123) break;
    out += ch;
    bytes += size;
  }
  return out;
}

/** 瀏覽器端可以送出的 close code（RFC 6455 §7.4）。 */
function sendableCloseCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  if (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) return code;
  return 1000;
}

class WsStream extends Stream {
  private ws: WebSocket | null = null;
  private resolveAccept: ((accepted: Accepted) => void) | null = null;
  private fragments: Uint8Array[] = [];
  private fragmentBytes = 0;
  /** 瀏覽器送來、還沒送給 Runner 的訊息。 */
  private readonly outgoing: { data: Uint8Array; binary: boolean }[] = [];
  private pumping = false;

  accepted(timeoutMs: number): Promise<Accepted> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.cancel();
        resolve({ ok: false, status: 504 });
      }, timeoutMs);
      this.resolveAccept = (accepted) => {
        clearTimeout(timer);
        this.resolveAccept = null;
        resolve(accepted);
      };
    });
  }

  attach(ws: WebSocket): void {
    if (this.closed) {
      ws.terminate();
      return;
    }
    this.ws = ws;
    ws.on("message", (data, isBinary) => {
      this.outgoing.push({ data: toBytes(data), binary: isBinary });
      // 送給 Runner 的速度跟不上時，先不讀瀏覽器的訊息
      if (this.outgoing.length > 1) ws.pause();
      void this.pump();
    });
    ws.on("close", (code, reason) => {
      if (this.closed) return;
      this.send({
        type: "preview_ws_close",
        stream_id: this.id,
        code,
        reason: closeReason(reason.toString()),
      });
      this.finish();
    });
    ws.on("error", () => this.cancel());
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const next = this.outgoing.shift();
        if (!next) break;
        const ok = await this.sendData(
          "ws_fragment",
          next.binary ? "ws_binary" : "ws_text",
          next.data,
        );
        if (!ok) return;
      }
      this.ws?.resume();
    } finally {
      this.pumping = false;
    }
  }

  onFrame(frame: PreviewFromRunner): void {
    switch (frame.type) {
      case "preview_response":
        this.resolveAccept?.(
          frame.status === 101 ? { ok: true, headers: frame.headers } : { ok: false, status: 502 },
        );
        if (frame.status !== 101) this.finish();
        return;
      case "preview_window":
        this.onWindow(frame.credit);
        return;
      case "preview_ws_close":
        this.ws?.close(sendableCloseCode(frame.code), closeReason(frame.reason));
        this.finish();
        return;
      case "preview_reset":
        this.fail(frame.message);
        return;
      case "preview_end":
        return;
    }
  }

  onData(kind: PreviewDataKind, payload: Uint8Array): void {
    if (!this.received(payload.byteLength)) return;
    const ws = this.ws;
    if (!ws || kind === "body") {
      this.fail("WebSocket stream 收到不合法的資料");
      return;
    }
    if (kind === "ws_fragment") {
      this.fragmentBytes += payload.byteLength;
      if (this.fragmentBytes > PREVIEW_MAX_WS_MESSAGE) {
        ws.close(1009, "message too big");
        this.send({ type: "preview_ws_close", stream_id: this.id, code: 1009, reason: "訊息太大" });
        this.finish();
        return;
      }
      this.fragments.push(Uint8Array.from(payload));
      // 先收在記憶體中（有上限），所以立刻補 credit，Runner 才送得完這則訊息
      this.grant(payload.byteLength);
      return;
    }
    const parts = [...this.fragments, payload];
    this.fragments = [];
    this.fragmentBytes = 0;
    const message = Buffer.concat(parts);
    const length = payload.byteLength;
    ws.send(message, { binary: kind === "ws_binary" }, () => this.grant(length));
  }

  fail(message: string): void {
    this.resolveAccept?.({ ok: false, status: 502 });
    if (this.ws) this.ws.close(1001, closeReason(message));
    this.finish();
  }
}
