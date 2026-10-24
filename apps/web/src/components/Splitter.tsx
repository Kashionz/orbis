// 垂直分割線：8px 的拖曳區、hover 時 2px 灰線、拖曳中 2px accent 線。
// 有最小與最大限制、雙擊重設、←→ 調整；值由呼叫端保存（通常存 localStorage）。

import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { clamp, stepValue } from "./geometry";
import "./Splitter.css";

interface SplitterProps {
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  /** 每按一次方向鍵的變化量。 */
  step: number;
  onChange: (value: number) => void;
  /**
   * 拖曳時把指標位置換算成值。`startValue` 與 `startX` 是按下時的值與指標 x 座標。
   */
  valueFromPointer: (clientX: number, startValue: number, startX: number) => number;
  /** → 鍵讓值變大（側欄寬度）或變小（右側面板佔比）。 */
  rightIncreases: boolean;
  label: string;
  /** aria-valuenow 的顯示（例如百分比）。 */
  valueText?: string;
  /** 分割線放在容器的左緣或右緣（-4px 外凸）。 */
  edge: "left" | "right";
}

export function Splitter({
  value,
  min,
  max,
  defaultValue,
  step,
  onChange,
  valueFromPointer,
  rightIncreases,
  label,
  valueText,
  edge,
}: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ value, x: 0 });

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    startRef.current = { value, x: event.clientX };
    setDragging(true);
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (moveEvent: globalThis.PointerEvent) => {
      const next = valueFromPointer(moveEvent.clientX, startRef.current.value, startRef.current.x);
      onChange(clamp(next, min, max));
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = "";
      setDragging(false);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const sign = (event.key === "ArrowRight") === rightIncreases ? 1 : -1;
    onChange(stepValue(value, sign * step, min, max));
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: 可聚焦的 separator（WAI-ARIA window splitter）沒有對應的原生元素
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      tabIndex={0}
      className="o-splitter"
      data-edge={edge}
      data-dragging={dragging}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onChange(defaultValue)}
      onKeyDown={onKeyDown}
    >
      <span className="o-splitter-line" />
    </div>
  );
}
