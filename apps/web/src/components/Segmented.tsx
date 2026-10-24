// 分段切換（主題、版面、看板篩選等）：radiogroup 語意，←→ 切換，選取項半粗體但不位移。

import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { FluidList, fluidItem } from "./FluidList";
import "./Segmented.css";

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
  icon?: ReactNode;
  /** 標籤右側的數字（例如待我處理的數量）。 */
  count?: number;
  /** 數字用警告色。 */
  countTone?: "warn" | "muted";
  disabled?: boolean;
  tooltip?: string;
}

interface SegmentedProps<V extends string> {
  value: V;
  options: SegmentedOption<V>[];
  onChange: (value: V) => void;
  /** 無障礙名稱。 */
  label: string;
  className?: string;
}

export function Segmented<V extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: SegmentedProps<V>) {
  const groupRef = useRef<HTMLDivElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const enabled = options.filter((option) => !option.disabled);
    const index = enabled.findIndex((option) => option.value === value);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? enabled.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length;
    const option = enabled[next];
    if (!option) return;
    onChange(option.value);
    groupRef.current?.querySelector<HTMLElement>(`[data-value="${option.value}"]`)?.focus();
  }

  return (
    <FluidList
      axis="x"
      role="radiogroup"
      aria-label={label}
      className={["o-segmented", className].filter(Boolean).join(" ")}
      onKeyDown={onKeyDown}
    >
      <div ref={groupRef} className="o-segmented-inner">
        {options.map((option) => {
          const active = option.value === value;
          return (
            // biome-ignore lint/a11y/useSemanticElements: 分段按鈕的外觀需要 button，語意是 radio
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              disabled={option.disabled}
              data-value={option.value}
              data-tip={option.tooltip}
              className="o-segmented-option"
              {...(option.disabled ? {} : fluidItem)}
              onClick={() => onChange(option.value)}
            >
              {option.icon}
              <span className="o-wstable">
                <span className="o-wstable-text" data-active={active}>
                  {option.label}
                </span>
                <span className="o-wstable-ghost" aria-hidden="true">
                  {option.label}
                </span>
              </span>
              {option.count !== undefined && option.count > 0 && (
                <span className="o-segmented-count" data-tone={option.countTone ?? "warn"}>
                  {option.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </FluidList>
  );
}
