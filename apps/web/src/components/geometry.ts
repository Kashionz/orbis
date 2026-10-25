// 浮層定位與拖曳的純計算（不碰 DOM，方便以 vitest 測試）。

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 離視窗邊緣至少留的距離。 */
const EDGE = 8;
/** 計算可用高度時，離視窗上下緣保留的空間。 */
const SAFE = 20;

export type VerticalPreference = "auto" | "up" | "down";

export interface MenuPlacementInput {
  anchor: Box;
  viewport: Viewport;
  /** 預估的內容高度（決定要不要翻轉）。 */
  estimatedHeight: number;
  width: number;
  prefer?: VerticalPreference;
  /** 對齊 anchor 的左緣（start）或右緣（end）。 */
  align?: "start" | "end";
  gap?: number;
}

export interface MenuPlacement {
  left: number;
  /** 往下開時的 top；往上開時為 null。 */
  top: number | null;
  /** 往上開時距視窗底部的距離；往下開時為 null。 */
  bottom: number | null;
  up: boolean;
  maxHeight: number;
}

/**
 * 選單的位置：預設開在空間較大的一側；偏好的一側放不下、另一側比較大時翻轉。
 * 高度上限是該側的可用空間（至少 160px），超過時選單內部捲動。
 */
export function placeMenu({
  anchor,
  viewport,
  estimatedHeight,
  width,
  prefer = "auto",
  align = "start",
  gap = 6,
}: MenuPlacementInput): MenuPlacement {
  const below = viewport.height - anchor.bottom - SAFE;
  const above = anchor.top - SAFE;
  let up = prefer === "up" ? true : prefer === "down" ? false : above > below;
  if (up && above < estimatedHeight && below > above) up = false;
  if (!up && below < estimatedHeight && above > below) up = true;
  const rawLeft = align === "end" ? anchor.right - width : anchor.left;
  const left = clamp(rawLeft, EDGE, Math.max(EDGE, viewport.width - width - EDGE));
  return {
    left: Math.round(left),
    top: up ? null : Math.round(anchor.bottom + gap),
    bottom: up ? Math.round(viewport.height - anchor.top + gap) : null,
    up,
    maxHeight: Math.max(160, Math.round(up ? above : below)),
  };
}

export interface TooltipPlacement {
  left: number;
  top: number;
  up: boolean;
}

/** Tooltip 放在 anchor 上方置中、間隔 8px；上方放不下時翻到下方；左右不超出視窗。 */
export function placeTooltip(
  anchor: Box,
  tip: { width: number; height: number },
  viewport: Viewport,
): TooltipPlacement {
  const gap = 8;
  const left = clamp(
    anchor.left + anchor.width / 2 - tip.width / 2,
    EDGE,
    Math.max(EDGE, viewport.width - tip.width - EDGE),
  );
  let top = anchor.top - tip.height - gap;
  let up = true;
  if (top < EDGE) {
    top = anchor.bottom + gap;
    up = false;
  }
  return { left: Math.round(left), top: Math.round(top), up };
}

/** 一組項目中，離指標最近的那一個（沿 x 軸、y 軸或兩軸距離）。沒有項目時回 -1。 */
export function nearestIndex(
  boxes: readonly Box[],
  point: { x: number; y: number },
  axis: "x" | "y" | "both",
): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  boxes.forEach((box, index) => {
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const distance =
      axis === "x"
        ? Math.abs(point.x - cx)
        : axis === "y"
          ? Math.abs(point.y - cy)
          : Math.hypot(point.x - cx, point.y - cy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** 方向鍵調整後的值：超出範圍時夾在 min 與 max 之間。 */
export function stepValue(
  value: number,
  delta: number,
  min: number,
  max: number,
  precision = 4,
): number {
  const factor = 10 ** precision;
  return clamp(Math.round((value + delta) * factor) / factor, min, max);
}
