import type { RunEvent, WebClientMessage } from "@orbis/api-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventSocket, type RunSubscription } from "./event-socket";

/** 只實作 EventSocket 用到的部分，記錄送出的訊息並讓測試觸發事件。 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  readonly sent: WebClientMessage[] = [];
  private readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as WebClientMessage);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  receive(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  drop(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function event(seq: number): RunEvent {
  return {
    runId: "run-1",
    seq,
    ts: "2026-10-23T08:00:00.000Z",
    event: { kind: "message_chunk", content: { type: "text", text: `#${seq}` } },
  } as RunEvent;
}

function subscription(afterSeq: () => number): RunSubscription & {
  received: RunEvent[][];
  errors: string[];
} {
  const received: RunEvent[][] = [];
  const errors: string[] = [];
  return {
    afterSeq,
    onEvents: (events) => received.push(events),
    onError: (message) => errors.push(message),
    received,
    errors,
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("EventSocket", () => {
  it("連上後以 subscribe_run 訂閱，afterSeq 是已套用的最後一個 seq", () => {
    const socket = new EventSocket(() => "ws://test/api/ws");
    socket.subscribe(
      "run-1",
      subscription(() => 0),
    );
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    expect(ws?.sent).toEqual([{ type: "subscribe_run", runId: "run-1", afterSeq: 0 }]);
  });

  it("run_events 一次帶一批 Event，原樣交給訂閱者", () => {
    const socket = new EventSocket(() => "ws://test/api/ws");
    const sub = subscription(() => 0);
    socket.subscribe("run-1", sub);
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    ws?.receive({ type: "run_events", runId: "run-1", events: [event(1), event(2)] });
    ws?.receive({ type: "run_events", runId: "run-2", events: [event(1)] });
    expect(sub.received).toEqual([[event(1), event(2)]]);
  });

  it("斷線重連後從已套用的最後一個 seq 之後續傳", () => {
    let lastSeq = 0;
    const socket = new EventSocket(() => "ws://test/api/ws");
    socket.subscribe(
      "run-1",
      subscription(() => lastSeq),
    );
    FakeWebSocket.instances[0]?.open();
    lastSeq = 42;
    FakeWebSocket.instances[0]?.drop();
    vi.runOnlyPendingTimers();
    const reconnected = FakeWebSocket.instances[1];
    reconnected?.open();
    expect(reconnected?.sent).toEqual([{ type: "subscribe_run", runId: "run-1", afterSeq: 42 }]);
  });

  it("最後一個訂閱取消時送 unsubscribe_run", () => {
    const socket = new EventSocket(() => "ws://test/api/ws");
    const unsubscribe = socket.subscribe(
      "run-1",
      subscription(() => 0),
    );
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    unsubscribe();
    expect(ws?.sent.at(-1)).toEqual({ type: "unsubscribe_run", runId: "run-1" });
  });

  it("錯誤代碼轉成說明：limit_exceeded 提示關閉其他 Run 頁面", () => {
    const socket = new EventSocket(() => "ws://test/api/ws");
    const sub = subscription(() => 0);
    socket.subscribe("run-1", sub);
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    ws?.receive({
      type: "error",
      code: "limit_exceeded",
      message: "最多 50 個",
      runId: "run-1",
    });
    ws?.receive({ type: "error", code: "forbidden", message: "", runId: null });
    expect(sub.errors).toEqual([
      "同時開啟的 Run 太多，請關閉其他 Run 頁面後重新整理：最多 50 個",
      "沒有權限查看這個 Run",
    ]);
  });
});
