// Web 的即時推送連線（`/api/ws`）：整個頁面共用一條。Run 的 Event 依 Run 訂閱，斷線後自動重連並從
// 各 Run 已套用的最後一個 seq 之後續傳；通知不需要訂閱，登入後由通知中心常駐監聽（ARCHITECTURE §12.3）。

import {
  API_ROUTES,
  type Notification,
  type RunEvent,
  type WEB_WS_ERROR_CODES,
  type WebClientMessage,
  WebServerMessage,
} from "@orbis/api-contract";

type WebWsErrorCode = (typeof WEB_WS_ERROR_CODES)[number];

/** WebSocket 錯誤代碼對應的說明；Server 的 `message` 附在後面。 */
const WS_ERROR_LABELS: Record<WebWsErrorCode, string> = {
  invalid_message: "即時連線的訊息格式錯誤",
  not_found: "找不到這個 Run",
  forbidden: "沒有權限查看這個 Run",
  limit_exceeded: "同時開啟的 Run 太多，請關閉其他 Run 頁面後重新整理",
};

export function wsErrorText(code: WebWsErrorCode, message: string): string {
  return message ? `${WS_ERROR_LABELS[code]}：${message}` : WS_ERROR_LABELS[code];
}

export interface RunSubscription {
  /** 已套用的最後一個 seq；（重新）訂閱時從它之後開始送。 */
  afterSeq: () => number;
  onEvents: (events: RunEvent[]) => void;
  onError?: (message: string) => void;
  /** 連線狀態改變（`true`＝已連上）。 */
  onConnectionChange?: (connected: boolean) => void;
}

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000];

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${API_ROUTES.ws}`;
}

export type NotificationListener = (notification: Notification) => void;

export class EventSocket {
  private socket: WebSocket | null = null;
  private readonly subscriptions = new Map<string, Set<RunSubscription>>();
  private readonly notificationListeners = new Set<NotificationListener>();
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
      this.send({ type: "subscribe_run", runId, afterSeq: subscription.afterSeq() });
    } else {
      this.connect();
    }
    return () => this.unsubscribe(runId, subscription);
  }

  /** 監聽給登入者的通知。有監聽者時連線一直開著（沒有訂閱任何 Run 也一樣）。 */
  listenNotifications(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    this.connect();
    return () => {
      this.notificationListeners.delete(listener);
      if (!this.hasListeners()) this.close();
    };
  }

  private hasListeners(): boolean {
    return this.subscriptions.size > 0 || this.notificationListeners.size > 0;
  }

  private unsubscribe(runId: string, subscription: RunSubscription): void {
    const set = this.subscriptions.get(runId);
    if (!set) return;
    set.delete(subscription);
    if (set.size > 0) return;
    this.subscriptions.delete(runId);
    this.send({ type: "unsubscribe_run", runId });
    if (!this.hasListeners()) this.close();
  }

  private connect(): void {
    if (this.socket || this.reconnectTimer) return;
    const socket = new WebSocket(this.url());
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      for (const [runId, set] of this.subscriptions) {
        const afterSeq = Math.min(...[...set].map((s) => s.afterSeq()));
        this.send({ type: "subscribe_run", runId, afterSeq });
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
    if (!this.hasListeners()) return;
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
    let parsed: WebServerMessage;
    try {
      parsed = WebServerMessage.parse(JSON.parse(data));
    } catch (error) {
      console.error("無法解析 Event WebSocket 的訊息", error);
      return;
    }
    if (parsed.type === "run_events") {
      for (const s of this.subscriptions.get(parsed.runId) ?? []) s.onEvents(parsed.events);
      return;
    }
    if (parsed.type === "notification") {
      for (const listener of this.notificationListeners) listener(parsed.notification);
      return;
    }
    const targets = parsed.runId
      ? (this.subscriptions.get(parsed.runId) ?? [])
      : [...this.subscriptions.values()].flatMap((set) => [...set]);
    const text = wsErrorText(parsed.code, parsed.message);
    for (const s of targets) s.onError?.(text);
  }

  private send(frame: WebClientMessage): void {
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
