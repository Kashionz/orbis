// Run Event 的 WebSocket 連線：整個頁面共用一條，依 Run 訂閱；斷線後自動重連並從各 Run
// 已套用的最後一個 seq 之後續傳。

import type { RunEvent } from "@orbis/api-contract";
import { API_PATHS } from "../../api/paths";
import { type ClientFrame, ServerFrame } from "../../api/schemas";

export interface RunSubscription {
  /** 下次（重新）訂閱要從哪個 seq 開始。 */
  nextSeq: () => number;
  onEvents: (events: RunEvent[]) => void;
  onError?: (message: string) => void;
  /** 連線狀態改變（`true`＝已連上）。 */
  onConnectionChange?: (connected: boolean) => void;
}

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000];

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${API_PATHS.eventsSocket}`;
}

export class EventSocket {
  private socket: WebSocket | null = null;
  private readonly subscriptions = new Map<string, Set<RunSubscription>>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: () => string = socketUrl) {}

  subscribe(runId: string, subscription: RunSubscription): () => void {
    let set = this.subscriptions.get(runId);
    if (!set) {
      set = new Set();
      this.subscriptions.set(runId, set);
    }
    set.add(subscription);
    if (this.socket?.readyState === WebSocket.OPEN) {
      subscription.onConnectionChange?.(true);
      this.send({ type: "subscribe", runId, fromSeq: subscription.nextSeq() });
    } else {
      this.connect();
    }
    return () => this.unsubscribe(runId, subscription);
  }

  private unsubscribe(runId: string, subscription: RunSubscription): void {
    const set = this.subscriptions.get(runId);
    if (!set) return;
    set.delete(subscription);
    if (set.size > 0) return;
    this.subscriptions.delete(runId);
    this.send({ type: "unsubscribe", runId });
    if (this.subscriptions.size === 0) this.close();
  }

  private connect(): void {
    if (this.socket || this.reconnectTimer) return;
    const socket = new WebSocket(this.url());
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      for (const [runId, set] of this.subscriptions) {
        const fromSeq = Math.min(...[...set].map((s) => s.nextSeq()));
        this.send({ type: "subscribe", runId, fromSeq });
        for (const s of set) s.onConnectionChange?.(true);
      }
    });
    socket.addEventListener("message", (message) => this.handleMessage(message.data));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const set of this.subscriptions.values()) {
        for (const s of set) s.onConnectionChange?.(false);
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.subscriptions.size === 0) return;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: ServerFrame;
    try {
      parsed = ServerFrame.parse(JSON.parse(data));
    } catch (error) {
      console.error("無法解析 Event WebSocket 的 frame", error);
      return;
    }
    if (parsed.type === "events") {
      for (const s of this.subscriptions.get(parsed.runId) ?? []) s.onEvents(parsed.events);
      return;
    }
    const targets = parsed.runId
      ? (this.subscriptions.get(parsed.runId) ?? [])
      : [...this.subscriptions.values()].flatMap((set) => [...set]);
    for (const s of targets) s.onError?.(parsed.message);
  }

  private send(frame: ClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private close(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}

let shared: EventSocket | null = null;

/** 整個頁面共用的連線。 */
export function sharedEventSocket(): EventSocket {
  shared ??= new EventSocket();
  return shared;
}
