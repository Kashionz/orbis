// 浮層的堆疊：Popover、選單、對話框開啟時登記，Esc 只關最上層（README：popover → dialog → menu）。

import { useEffect, useRef } from "react";

interface Layer {
  id: number;
  close: () => void;
}

const stack: Layer[] = [];
let nextId = 1;
let listening = false;

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  top.close();
}

function ensureListener() {
  if (listening || typeof document === "undefined") return;
  // capture：比元件自己的 onKeyDown 早一步，確保只關最上層
  document.addEventListener("keydown", onKeyDown, true);
  listening = true;
}

/** 開啟期間把浮層放到最上層；Esc 會呼叫 `close`。 */
export function useLayer(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    ensureListener();
    const layer: Layer = { id: nextId++, close: () => closeRef.current() };
    stack.push(layer);
    return () => {
      const index = stack.findIndex((l) => l.id === layer.id);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [open]);
}

/** 目前有沒有開啟中的浮層（全域快捷鍵在有浮層時不處理 Esc 等按鍵）。 */
export function hasOpenLayer(): boolean {
  return stack.length > 0;
}
