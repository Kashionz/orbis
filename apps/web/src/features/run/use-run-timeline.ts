// 訂閱一個 Run 的 Event 並維護它的時間軸。

import type { RunEvent } from "@orbis/api-contract";
import { useEffect, useState, useSyncExternalStore } from "react";
import { fetchRunEvents } from "../../api/resources";
import { type EventSocket, sharedEventSocket } from "./event-socket";
import { applyEvents, EMPTY_TIMELINE, missingSeq, type Timeline } from "./timeline";

/** 發現缺號後等多久才用 REST 補抓（WebSocket 的 Event 可能只是晚到）。 */
const GAP_FILL_DELAY_MS = 1_000;
const GAP_FILL_PAGE_SIZE = 1_000;

/**
 * 一個 Run 的時間軸。收到的 Event 先累積，每個畫格（requestAnimationFrame）才套用一次，
 * 大量重播時不會每筆都重新渲染。
 */
export class RunTimelineStore {
  private timeline: Timeline = EMPTY_TIMELINE;
  private queue: RunEvent[] = [];
  private frame: number | null = null;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly runId: string,
    private readonly fetchAfter: (afterSeq: number) => Promise<RunEvent[]> = (afterSeq) =>
      fetchRunEvents(runId, afterSeq, GAP_FILL_PAGE_SIZE),
  ) {}

  getSnapshot = (): Timeline => this.timeline;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 已連續套用的最後一個 seq（重新訂閱時從它之後續傳）。 */
  afterSeq = (): number => this.timeline.lastSeq;

  push = (events: readonly RunEvent[]): void => {
    this.queue.push(...events);
    if (this.frame === null) this.frame = requestAnimationFrame(this.flush);
  };

  /** 立即套用累積的 Event（測試與頁面卸載前使用）。 */
  flush = (): void => {
    this.frame = null;
    if (this.queue.length === 0) return;
    const queued = this.queue;
    this.queue = [];
    const next = applyEvents(this.timeline, queued);
    if (next !== this.timeline) {
      this.timeline = next;
      for (const listener of this.listeners) listener();
    }
    this.scheduleGapFill();
  };

  private scheduleGapFill(): void {
    if (this.gapTimer || missingSeq(this.timeline) === null) return;
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      void this.fillGap();
    }, GAP_FILL_DELAY_MS);
  }

  private async fillGap(): Promise<void> {
    if (missingSeq(this.timeline) === null) return;
    try {
      const events = await this.fetchAfter(this.timeline.lastSeq);
      this.push(events);
    } catch (error) {
      console.error("補抓缺少的 Event 失敗", error);
      this.scheduleGapFill();
    }
  }

  dispose(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.frame = null;
    this.gapTimer = null;
  }
}

export interface RunTimelineState {
  timeline: Timeline;
  connected: boolean;
  error: string | null;
}

export function useRunTimeline(
  runId: string,
  socket: EventSocket = sharedEventSocket(),
): RunTimelineState {
  const [store, setStore] = useState(() => new RunTimelineStore(runId));
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (store.runId !== runId) setStore(new RunTimelineStore(runId));

  useEffect(() => {
    if (store.runId !== runId) return;
    const unsubscribe = socket.subscribe(runId, {
      afterSeq: store.afterSeq,
      onEvents: store.push,
      onError: setError,
      onConnectionChange: setConnected,
    });
    return () => {
      unsubscribe();
      store.dispose();
    };
  }, [runId, socket, store]);

  const timeline = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { timeline, connected, error };
}
