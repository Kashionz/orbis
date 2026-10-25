import type { CSSProperties } from "react";

interface StatusDotProps {
  /** 顏色 token，例如 `var(--o7fb0fa)`。 */
  color: string;
  /** 執行中：閃爍。 */
  live?: boolean;
  size?: number;
  label?: string;
}

/** 狀態點：靜止或閃爍（reduced-motion 時不閃）。 */
export function StatusDot({ color, live = false, size = 6, label }: StatusDotProps) {
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    background: color,
    display: "inline-block",
    flex: "none",
  };
  const className = live ? "o-pulse" : undefined;
  if (label)
    return (
      <span className={className} style={style} data-live={live} role="img" aria-label={label} />
    );
  return <span className={className} style={style} data-live={live} aria-hidden="true" />;
}
