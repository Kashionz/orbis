// 通知的發送管道（Channel，ARCHITECTURE §12.3）。NotificationService 先套用個人設定、存進通知表，
// commit 之後再交給各 Channel。之後要加 email、Slack 時新增一個 Channel 即可。
//
// - `in_app`：通知中心。通知表本身就是它的儲存；這裡另外經由 `/api/ws` 即時推送給本人所有的 Web 連線。
// - `desktop`：Electron 每 5 秒輪詢桌面通知 feed（`desktop = true` 的通知），Server 不主動推送。

import type {
  NotificationChannel as ChannelId,
  Notification,
  WebServerMessage,
} from "@orbis/api-contract";

export interface DeliveredNotification {
  memberId: string;
  /** API 形狀的通知（已帶 Task Key）。 */
  notification: Notification;
  /** 是否要推送到桌面（勿擾時段中為 false）。 */
  desktop: boolean;
}

export interface NotificationChannel {
  readonly id: ChannelId;
  deliver(delivered: DeliveredNotification): Promise<void>;
}

type Listener = (message: WebServerMessage) => void;

/** 每位 Member 目前的 Web 連線（`/api/ws`），讓 Server 推送不需要訂閱的訊息。 */
export class WebPushHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  /** 登記一條連線；回傳取消登記的函式。 */
  subscribe(memberId: string, listener: Listener): () => void {
    let set = this.listeners.get(memberId);
    if (!set) {
      set = new Set();
      this.listeners.set(memberId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) this.listeners.delete(memberId);
    };
  }

  push(memberId: string, message: WebServerMessage): void {
    for (const listener of this.listeners.get(memberId) ?? []) listener(message);
  }
}

export class InAppChannel implements NotificationChannel {
  readonly id = "in_app" as const;

  constructor(private readonly push: WebPushHub) {}

  async deliver({ memberId, notification }: DeliveredNotification): Promise<void> {
    this.push.push(memberId, { type: "notification", notification });
  }
}

/** 桌面推送：Electron 輪詢 feed，所以送出時不必做事；保留 Channel 讓發送流程一致。 */
export class DesktopChannel implements NotificationChannel {
  readonly id = "desktop" as const;

  async deliver(): Promise<void> {}
}
