// Fluid hover：一個列表共用一個高亮塊，滑到離指標最近的項目（80ms），離開時淡出。
// 項目加 `data-fluid-item`；高亮塊也跟著鍵盤 focus 移動。reduced-motion 時直接跳到位置。

import {
  type ElementType,
  type HTMLAttributes,
  type FocusEvent as ReactFocusEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useRef,
} from "react";
import { nearestIndex } from "./geometry";
import "./FluidList.css";

type FluidListProps = HTMLAttributes<HTMLElement> & {
  axis?: "x" | "y";
  as?: ElementType;
  /** 高亮塊上下內縮（px），讓高亮比項目矮一點。 */
  inset?: number;
  children: ReactNode;
};

const ITEM_SELECTOR = "[data-fluid-item]";

function itemsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
    (element) =>
      element.closest("[data-fluid-list]") === container && element.getClientRects().length > 0,
  );
}

export function FluidList({
  axis = "y",
  as: Component = "div",
  inset = 0,
  className,
  children,
  onPointerMove,
  onPointerLeave,
  onFocus,
  onBlur,
  ...rest
}: FluidListProps) {
  const containerRef = useRef<HTMLElement>(null);
  const highlightRef = useRef<HTMLSpanElement>(null);
  const activeRef = useRef<HTMLElement | null>(null);

  const place = useCallback(
    (element: HTMLElement) => {
      const container = containerRef.current;
      const highlight = highlightRef.current;
      if (!container || !highlight) return;
      const fresh = activeRef.current === null;
      const box = container.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const x = rect.left - box.left - container.clientLeft + container.scrollLeft;
      const y = rect.top - box.top - container.clientTop + container.scrollTop + inset;
      highlight.dataset.moving = fresh ? "false" : "true";
      highlight.style.transform = `translate(${x}px, ${y}px)`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${Math.max(0, rect.height - inset * 2)}px`;
      highlight.dataset.visible = "true";
      activeRef.current = element;
    },
    [inset],
  );

  const hide = useCallback(() => {
    const highlight = highlightRef.current;
    if (highlight) highlight.dataset.visible = "false";
    activeRef.current = null;
  }, []);

  return (
    <Component
      {...rest}
      ref={containerRef}
      data-fluid-list=""
      className={["o-fluid", className].filter(Boolean).join(" ")}
      onPointerMove={(event: ReactPointerEvent<HTMLElement>) => {
        onPointerMove?.(event);
        const container = containerRef.current;
        if (!container || event.pointerType === "touch") return;
        const items = itemsOf(container).filter(
          (item) => item.getAttribute("aria-disabled") !== "true" && !item.hasAttribute("disabled"),
        );
        const index = nearestIndex(
          items.map((item) => item.getBoundingClientRect()),
          { x: event.clientX, y: event.clientY },
          axis,
        );
        const item = items[index];
        if (!item) hide();
        else if (item !== activeRef.current) place(item);
      }}
      onPointerLeave={(event: ReactPointerEvent<HTMLElement>) => {
        onPointerLeave?.(event);
        hide();
      }}
      onFocus={(event: ReactFocusEvent<HTMLElement>) => {
        onFocus?.(event);
        const item = (event.target as HTMLElement).closest<HTMLElement>(ITEM_SELECTOR);
        if (item?.matches(":focus-visible")) place(item);
      }}
      onBlur={(event: ReactFocusEvent<HTMLElement>) => {
        onBlur?.(event);
        if (!containerRef.current?.contains(event.relatedTarget as Node | null)) hide();
      }}
    >
      <span
        ref={highlightRef}
        className="o-fluid-highlight"
        aria-hidden="true"
        data-visible="false"
      />
      {children}
    </Component>
  );
}

/** 列表項目要加的屬性。 */
export const fluidItem = { "data-fluid-item": "" } as const;
