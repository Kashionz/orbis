import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 元素目前的寬度（ResizeObserver）。標題列依寬度逐步收合時使用；
 * 變化小於 `threshold` px 時不更新，避免拖曳分割線時一直重新渲染。
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>, threshold = 8): number {
  const [width, setWidth] = useState(0);
  const last = useRef(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (next: number) => {
      const rounded = Math.round(next);
      if (Math.abs(rounded - last.current) <= threshold && last.current !== 0) return;
      last.current = rounded;
      setWidth(rounded);
    };
    update(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, threshold]);
  return width;
}

/**
 * 全域快捷鍵（Ctrl 或 ⌘ 加上 `key`）。輸入框中也會觸發，因為 Ctrl+K、Ctrl+, 是全域動作。
 */
export function useModifierShortcut(key: string, handler: () => void, enabled = true): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== key.toLowerCase()) return;
      event.preventDefault();
      handlerRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [key, enabled]);
}
