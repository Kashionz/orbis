import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ItemControls } from "./TimelineItemView";
import { TimelineItemView } from "./TimelineItemView";
import type { TimelineItem } from "./timeline";

/** 距離底部多少 px 以內算是「在底部」，新的 Event 進來時自動跟隨。 */
const FOLLOW_THRESHOLD_PX = 48;

interface VirtualTimelineProps {
  items: readonly TimelineItem[];
  controls: ItemControls;
  /** 要捲到並標示的項目 key（例如從 Needs You 跳過來的權限請求）。 */
  focusKey: string | undefined;
}

/** Run 的時間軸：動態高度的虛擬列表，只渲染看得到的項目。 */
export function VirtualTimeline({ items, controls, focusKey }: VirtualTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(focusKey === undefined);
  const focusedRef = useRef(false);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 6,
    getItemKey: (index) => items[index]?.key ?? index,
  });

  // 在底部時跟著新的 Event 捲動
  useLayoutEffect(() => {
    if (followRef.current && items.length > 0) {
      virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    }
  }, [items, virtualizer]);

  // 捲到指定的項目（只做一次）
  useEffect(() => {
    if (!focusKey || focusedRef.current) return;
    const index = items.findIndex((item) => item.key === focusKey);
    if (index < 0) return;
    focusedRef.current = true;
    virtualizer.scrollToIndex(index, { align: "center" });
  }, [focusKey, items, virtualizer]);

  return (
    <div
      ref={scrollRef}
      className="timeline"
      data-testid="timeline"
      data-item-count={items.length}
      onScroll={(event) => {
        const el = event.currentTarget;
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
      }}
    >
      {items.length === 0 && <p className="empty">還沒有 Event</p>}
      <div className="timeline-inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index];
          if (!item) return null;
          return (
            <div
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={row.index}
              data-key={item.key}
              data-type={item.type}
              data-focused={item.key === focusKey ? "true" : undefined}
              className="timeline-row"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <TimelineItemView item={item} controls={controls} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
