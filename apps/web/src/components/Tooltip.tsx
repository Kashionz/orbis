// 取代原生 title 的 Tooltip。整個 App 只有一個 TooltipLayer，以事件委派處理所有帶 `data-tip`
// （或 `title`，第一次 hover 時轉成 `data-tip`）的元素：
// - 450ms 延遲；上一個 Tooltip 在 300ms 內關閉時立即顯示。
// - 放在上方，放不下時翻到下方；pointerdown、捲動、視窗失焦時隱藏。
// - 鍵盤 focus（:focus-visible）也會顯示。
// 路徑等等寬字串加 `data-tip-mono`。

import { cloneElement, type ReactElement, useEffect, useRef } from "react";
import { placeTooltip } from "./geometry";
import "./Tooltip.css";

const SHOW_DELAY_MS = 450;
const WARM_MS = 300;

function tipTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const element = node.closest<HTMLElement>("[data-tip],[title]");
  if (!element) return null;
  // SVG 的 <title> 是無障礙名稱，不是 title 屬性
  const title = element.getAttribute("title");
  if (title !== null) {
    element.setAttribute("data-tip", title);
    element.removeAttribute("title");
  }
  return element.getAttribute("data-tip") ? element : null;
}

export function TooltipLayer() {
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tip = tipRef.current;
    if (!tip) return;
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let warmTimer: ReturnType<typeof setTimeout> | undefined;
    let warm = false;

    function show(element: HTMLElement) {
      if (!tip) return;
      const text = element.getAttribute("data-tip");
      if (!text || !element.isConnected) {
        hide();
        return;
      }
      tip.textContent = text;
      tip.dataset.mono = element.hasAttribute("data-tip-mono") ? "true" : "false";
      const placement = placeTooltip(
        element.getBoundingClientRect(),
        { width: tip.offsetWidth, height: tip.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      tip.style.left = `${placement.left}px`;
      tip.style.top = `${placement.top}px`;
      tip.dataset.up = String(placement.up);
      tip.dataset.visible = "true";
      warm = true;
      clearTimeout(warmTimer);
    }

    function hide() {
      clearTimeout(timer);
      if (tip?.dataset.visible === "true") {
        tip.dataset.visible = "false";
        clearTimeout(warmTimer);
        warmTimer = setTimeout(() => {
          warm = false;
        }, WARM_MS);
      }
      current = null;
    }

    function enter(element: HTMLElement | null) {
      if (element === current) return;
      if (!element) {
        if (current) hide();
        return;
      }
      current = element;
      clearTimeout(timer);
      if (warm) show(element);
      else
        timer = setTimeout(() => {
          if (current === element) show(element);
        }, SHOW_DELAY_MS);
    }

    const onOver = (event: PointerEvent) => enter(tipTarget(event.target));
    const onFocusIn = (event: FocusEvent) => {
      const element = tipTarget(event.target);
      if (element?.matches(":focus-visible")) enter(element);
    };
    const onFocusOut = () => hide();
    const onDismiss = () => hide();

    document.addEventListener("pointerover", onOver, { passive: true });
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", onDismiss, true);
    document.addEventListener("scroll", onDismiss, true);
    window.addEventListener("blur", onDismiss);
    return () => {
      clearTimeout(timer);
      clearTimeout(warmTimer);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onDismiss, true);
      document.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("blur", onDismiss);
    };
  }, []);

  return <div ref={tipRef} className="o-tooltip" role="tooltip" data-visible="false" />;
}

/**
 * 幫子元素加上 Tooltip（`data-tip`）。`text` 為 null 時不加。
 * icon-only 按鈕請另外給 `aria-label`，Tooltip 不是無障礙名稱。
 */
export function Tooltip({
  text,
  mono = false,
  children,
}: {
  text: string | null | undefined;
  mono?: boolean;
  children: ReactElement<Record<string, unknown>>;
}) {
  if (!text) return children;
  return cloneElement(children, {
    "data-tip": text,
    ...(mono && { "data-tip-mono": "" }),
  });
}

/** 直接展開到元素上的 Tooltip 屬性：`<span {...tip("…")}>`。 */
export function tip(text: string | null | undefined, mono = false): Record<string, string> {
  if (!text) return {};
  return mono ? { "data-tip": text, "data-tip-mono": "" } : { "data-tip": text };
}
