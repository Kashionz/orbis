// 目前連線中的 Runner。Dispatcher 與 RunControl 透過這裡送 frame 給 Runner。

import type { ServerToRunner } from "@orbis/protocol";

export interface RunnerLink {
  send(frame: ServerToRunner): boolean;
  close(code: number, reason: string): void;
}

interface Entry {
  link: RunnerLink;
  /**
   * Runner 是否接受新的 Dispatch（Heartbeat 的 accepting_dispatches）。
   * 連線後收到第一個 Heartbeat 之前一律是 false：重新連線的 Runner 可能還在「暫停領取」。
   */
  acceptingDispatches: boolean;
}

/** 撤銷 Runner 時關閉連線用的 close code。 */
export const CLOSE_REVOKED = 4001;

export class RunnerHub {
  private readonly entries = new Map<string, Entry>();
  private readonly connectListeners = new Set<(runnerId: string) => void>();

  /** 登記連線；同一個 Runner 已有連線時取代舊的（由呼叫端關閉舊連線）。 */
  register(runnerId: string, link: RunnerLink): void {
    this.entries.set(runnerId, { link, acceptingDispatches: false });
    for (const listener of this.connectListeners) listener(runnerId);
  }

  /** 移除連線；只有目前登記的就是這條連線時才移除。 */
  unregister(runnerId: string, link: RunnerLink): void {
    if (this.entries.get(runnerId)?.link === link) this.entries.delete(runnerId);
  }

  isOnline(runnerId: string): boolean {
    return this.entries.has(runnerId);
  }

  isAcceptingDispatches(runnerId: string): boolean {
    return this.entries.get(runnerId)?.acceptingDispatches ?? false;
  }

  setAcceptingDispatches(runnerId: string, accepting: boolean): void {
    const entry = this.entries.get(runnerId);
    if (entry) entry.acceptingDispatches = accepting;
  }

  /** 送出 frame；Runner 不在線上時回傳 false。 */
  send(runnerId: string, frame: ServerToRunner): boolean {
    return this.entries.get(runnerId)?.link.send(frame) ?? false;
  }

  disconnect(runnerId: string, code: number, reason: string): void {
    const entry = this.entries.get(runnerId);
    if (!entry) return;
    this.entries.delete(runnerId);
    entry.link.close(code, reason);
  }

  onlineRunnerIds(): string[] {
    return [...this.entries.keys()];
  }

  /** Runner 完成 Hello 時通知（用來補送未回覆的 RunControl）。 */
  onConnect(listener: (runnerId: string) => void): () => void {
    this.connectListeners.add(listener);
    return () => this.connectListeners.delete(listener);
  }
}
