// 在 Preview 上選取元素（ARCHITECTURE §13「Preview 留言」）。
// 這些函式會被轉成原始碼字串，以 executeJavaScriptInIsolatedWorld 注入內嵌瀏覽器執行：
// isolated world 和頁面共用 DOM，但頁面的 script 碰不到這裡的變數與事件處理。
// 所以函式必須自給自足：不能使用外部的變數、import 或 helper。

/** 選取的結果（不含截圖；截圖由 main 程序在選取後擷取）。 */
export interface RawPick {
  selector: string;
  url: string;
  rect: { x: number; y: number; width: number; height: number };
  tagName: string;
  text: string;
}

/** overlay 元素的 ID 前綴。 */
export const OVERLAY_ID = "__preview_pick_overlay";

/**
 * 進入選取模式：滑鼠下的元素以外框標示；點擊時回傳該元素的資訊並保留外框（給截圖用），
 * Esc 取消時回傳 null。選取期間攔下點擊，不讓頁面收到。
 */
function startPicking(overlayId: string): Promise<RawPick | null> {
  const previous = document.getElementById(overlayId);
  if (previous) previous.remove();
  const box = document.createElement("div");
  box.id = overlayId;
  box.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "pointer-events:none",
    "box-sizing:border-box",
    "border:2px solid #e5484d",
    "background:rgba(229,72,77,0.12)",
    "display:none",
  ].join(";");
  document.documentElement.appendChild(box);

  const cssEscape = (value: string) =>
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, "\\$&");
  const unique = (selector: string, el: Element) => {
    try {
      const found = document.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch {
      return false;
    }
  };
  /** 唯一的 CSS selector：id → data-testid → 由下往上的 `tag:nth-of-type()` 路徑。 */
  const selectorOf = (el: Element): string => {
    if (el.id && unique(`#${cssEscape(el.id)}`, el)) return `#${cssEscape(el.id)}`;
    const testId = el.getAttribute("data-testid");
    if (testId) {
      const byTestId = `[data-testid="${testId.replace(/["\\]/g, "\\$&")}"]`;
      if (unique(byTestId, el)) return byTestId;
    }
    const parts: string[] = [];
    let current: Element | null = el;
    while (current && current !== document.documentElement) {
      if (current !== el && current.id && unique(`#${cssEscape(current.id)}`, current)) {
        parts.unshift(`#${cssEscape(current.id)}`);
        break;
      }
      const tag = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      const sameTag = parent
        ? Array.from(parent.children).filter((c) => c.tagName === current?.tagName)
        : [];
      parts.unshift(
        sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(current) + 1})` : tag,
      );
      const candidate = parts.join(" > ");
      if (unique(candidate, el)) return candidate;
      current = parent;
    }
    return parts.join(" > ");
  };

  let target: Element | null = null;
  const place = (el: Element) => {
    const r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
  };

  return new Promise((resolve) => {
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onMove = (event: MouseEvent) => {
      const el = document.elementFromPoint(event.clientX, event.clientY);
      if (!el || el === box) return;
      target = el;
      place(el);
    };
    const finish = (result: RawPick | null) => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
      for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"]) {
        window.removeEventListener(type, swallow, true);
      }
      if (!result) box.remove();
      resolve(result);
    };
    const onClick = (event: MouseEvent) => {
      swallow(event);
      const el = document.elementFromPoint(event.clientX, event.clientY) ?? target;
      if (!el || el === box) return;
      place(el);
      const r = el.getBoundingClientRect();
      finish({
        selector: selectorOf(el),
        url: location.href,
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        tagName: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
      });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      swallow(event);
      finish(null);
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"]) {
      window.addEventListener(type, swallow, true);
    }
  });
}

/** 移除選取的外框（截圖之後）。 */
function removeOverlay(overlayId: string): void {
  document.getElementById(overlayId)?.remove();
}

/** 注入用的原始碼：進入選取模式，結果是 `RawPick | null`。 */
export function startPickingScript(): string {
  return `(${startPicking.toString()})(${JSON.stringify(OVERLAY_ID)})`;
}

/** 注入用的原始碼：移除外框。 */
export function removeOverlayScript(): string {
  return `(${removeOverlay.toString()})(${JSON.stringify(OVERLAY_ID)})`;
}

/** 檢查注入回來的值；頁面可以影響 DOM，回傳值不能直接信任。 */
export function parseRawPick(value: unknown): RawPick | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const rect = v.rect as Record<string, unknown> | undefined;
  const isNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  if (
    typeof v.selector !== "string" ||
    typeof v.url !== "string" ||
    typeof v.tagName !== "string" ||
    typeof v.text !== "string" ||
    !rect ||
    !isNumber(rect.x) ||
    !isNumber(rect.y) ||
    !isNumber(rect.width) ||
    !isNumber(rect.height)
  ) {
    return null;
  }
  return {
    selector: v.selector.slice(0, 2000),
    url: v.url.slice(0, 4000),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    tagName: v.tagName.slice(0, 100),
    text: v.text.slice(0, 200),
  };
}
