// 事件串流：動態高度的虛擬列表，只渲染看得到的項目。
// - 在底部時跟著新的事件捲動；往上捲之後出現「N 筆新事件」，按下回到底部。
// - 一開始只顯示最後 WINDOW 個項目，上方的「載入較早的 N 筆事件」每次多顯示 WINDOW 個（協調者 Q9）。
// - `focusKey`（例如從待我處理跳過來的權限請求）會捲到那個項目並短暫標示。

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../../i18n";
import {
  ErrorRow,
  HeadRow,
  MessageRow,
  PermissionRow,
  PlanProposedRow,
  PlanRow,
  PromptRow,
  PullRequestRow,
  RateLimitedRow,
  StatusRow,
  SwitchRow,
  SystemRow,
  TailRow,
  ThoughtRow,
  VerificationRow,
} from "./StreamRows";
import { useStreamEnv } from "./stream-context";
import type { StreamItem, StreamTail } from "./stream-model";
import { ToolGroupView } from "./ToolGroupView";
import "./stream.css";

/** 一次顯示的項目數。 */
export const STREAM_WINDOW = 300;
/** 距離底部多少 px 以內算是「在底部」。 */
const FOLLOW_THRESHOLD_PX = 48;
/** focus 的項目標示多久。 */
const FOCUS_HIGHLIGHT_MS = 2600;

type Row =
  | { kind: "earlier"; key: string; hidden: number }
  | { kind: "item"; key: string; item: StreamItem; first: boolean }
  | { kind: "tail"; key: string; tail: StreamTail };

interface EventStreamProps {
  items: readonly StreamItem[];
  tail: StreamTail | null;
  /** 還在取得事件（顯示骨架）。 */
  loading: boolean;
  /** dock 顯示時「N 筆新事件」要往上移。 */
  dockShown: boolean;
}

function seqOf(item: StreamItem): number | null {
  return "item" in item && item.item ? item.item.seq : null;
}

function tsOf(item: StreamItem): string {
  switch (item.kind) {
    case "tool_group":
      return item.tools[0]?.ts ?? "";
    case "verification_group":
      return item.results[0]?.ts ?? "";
    case "switch":
      return item.change.ts;
    case "pull_request":
      return item.pr.openedAt;
    default:
      return item.item.ts;
  }
}

function ItemBody({ item }: { item: StreamItem }) {
  switch (item.kind) {
    case "prompt":
      return <PromptRow item={item} />;
    case "message":
      return <MessageRow item={item} />;
    case "thought":
      return <ThoughtRow item={item} />;
    case "tool_group":
      return <ToolGroupView item={item} />;
    case "plan":
      return <PlanRow item={item} />;
    case "plan_proposed":
      return <PlanProposedRow item={item} />;
    case "verification_group":
      return <VerificationRow item={item} />;
    case "permission":
      return <PermissionRow item={item} />;
    case "status":
      return <StatusRow item={item} />;
    case "error":
      return <ErrorRow item={item} />;
    case "rate_limited":
      return <RateLimitedRow item={item} />;
    case "system":
      return <SystemRow item={item} />;
    case "switch":
      return <SwitchRow item={item} />;
    case "pull_request":
      return <PullRequestRow item={item} />;
  }
}

export function EventStream({ items, tail, loading, dockShown }: EventStreamProps) {
  const t = useT();
  const env = useStreamEnv();
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(env.focusKey === null);
  const [following, setFollowing] = useState(env.focusKey === null);
  /** 停止跟隨時已有的項目數（算「N 筆新事件」）。 */
  const [seenCount, setSeenCount] = useState(0);
  /** 固定的第一個顯示項目；null 表示顯示最後 WINDOW 個。 */
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(env.focusKey);
  const focusedRef = useRef(false);

  const start = useMemo(() => {
    const anchored = anchorKey ? items.findIndex((item) => item.key === anchorKey) : -1;
    let index = anchored >= 0 ? anchored : Math.max(0, items.length - STREAM_WINDOW);
    // focus 的項目一定要在顯示範圍內
    if (env.focusKey && !focusedRef.current) {
      const focus = items.findIndex((item) => item.key === env.focusKey);
      if (focus >= 0 && focus < index) index = Math.max(0, focus - 20);
    }
    return index;
  }, [items, anchorKey, env.focusKey]);

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = [];
    if (start > 0) list.push({ kind: "earlier", key: "earlier", hidden: start });
    items
      .slice(start)
      .forEach((item, index) =>
        list.push({ kind: "item", key: item.key, item, first: start + index === 0 }),
      );
    if (tail) list.push({ kind: "tail", key: "tail", tail });
    return list;
  }, [items, start, tail]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 6,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  // 在底部時跟著新的事件捲動
  useLayoutEffect(() => {
    if (followRef.current && rows.length > 0) {
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    }
  }, [rows, virtualizer]);

  // 捲到 focus 的項目（只做一次）
  useEffect(() => {
    if (!env.focusKey || focusedRef.current) return;
    const index = rows.findIndex((row) => row.key === env.focusKey);
    if (index < 0) return;
    focusedRef.current = true;
    followRef.current = false;
    setFollowing(false);
    setSeenCount(items.length);
    setAnchorKey(rows.find((row) => row.kind === "item")?.key ?? null);
    virtualizer.scrollToIndex(index, { align: "center" });
    setHighlight(env.focusKey);
    const timer = setTimeout(() => setHighlight(null), FOCUS_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [env.focusKey, rows, items.length, virtualizer]);

  // 從輸入框的 dock「跳至請求」：focusKey 換成新的值時重新捲動
  const lastFocus = useRef(env.focusKey);
  if (lastFocus.current !== env.focusKey) {
    lastFocus.current = env.focusKey;
    focusedRef.current = false;
  }

  function jumpToLatest() {
    followRef.current = true;
    setFollowing(true);
    setAnchorKey(null);
    virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
  }

  function loadEarlier() {
    const el = scrollRef.current;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    const next = Math.max(0, start - STREAM_WINDOW);
    followRef.current = false;
    setFollowing(false);
    setSeenCount(items.length);
    setAnchorKey(items[next]?.key ?? null);
    // 保持目前看到的位置
    requestAnimationFrame(() => {
      const after = scrollRef.current;
      if (after) after.scrollTop = after.scrollHeight - fromBottom;
    });
  }

  const newCount = following ? 0 : Math.max(0, items.length - seenCount);

  return (
    <div className="st-wrap">
      <div
        ref={scrollRef}
        className="st-scroll"
        data-testid="timeline"
        data-item-count={items.length}
        role="log"
        aria-label={t.workspace.stream.label}
        onScroll={(event) => {
          const el = event.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
          if (near === followRef.current) return;
          followRef.current = near;
          setFollowing(near);
          if (!near) {
            setSeenCount(items.length);
            setAnchorKey(rows.find((row) => row.kind === "item")?.key ?? null);
          }
        }}
      >
        <div className="st-column">
          {loading && items.length === 0 ? (
            <StreamSkeleton />
          ) : (
            <div className="st-inner" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((virtual) => {
                const row = rows[virtual.index];
                if (!row) return null;
                return (
                  <div
                    key={virtual.key}
                    ref={virtualizer.measureElement}
                    data-index={virtual.index}
                    className="st-row"
                    style={{ transform: `translateY(${virtual.start}px)` }}
                  >
                    {row.kind === "earlier" && (
                      <button type="button" className="st-earlier" onClick={loadEarlier}>
                        {t.workspace.stream.loadEarlier(row.hidden.toLocaleString("en-US"))}
                      </button>
                    )}
                    {row.kind === "tail" && <TailRow tail={row.tail} />}
                    {row.kind === "item" && (
                      <div
                        className="st-item timeline-row"
                        data-key={row.item.key}
                        data-type={row.item.kind}
                        data-focused={highlight === row.item.key ? "true" : undefined}
                      >
                        {row.item.head && (
                          <HeadRow
                            head={row.item.head}
                            ts={tsOf(row.item)}
                            seq={seqOf(row.item)}
                            first={row.first}
                          />
                        )}
                        <div className="st-body">
                          <ItemBody item={row.item} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {newCount > 0 && (
        <button type="button" className="st-new" data-dock={dockShown} onClick={jumpToLatest}>
          {t.workspace.stream.newEvents(newCount)}
        </button>
      )}
    </div>
  );
}

const SKELETON = [
  ["62%", "84%"],
  ["34%", "48%"],
  ["70%", "56%"],
  ["28%", "64%"],
  ["52%", "38%"],
] as const;

function StreamSkeleton() {
  return (
    <div className="st-skeleton" aria-hidden="true">
      {SKELETON.map(([a, b]) => (
        <div key={a + b} className="st-skeleton-pair">
          <div className="st-skeleton-bar" style={{ width: a }} />
          <div className="st-skeleton-bar" data-second="true" style={{ width: b }} />
        </div>
      ))}
    </div>
  );
}
