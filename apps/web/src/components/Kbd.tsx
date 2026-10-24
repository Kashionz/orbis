import type { CSSProperties } from "react";

/** macOS 用 ⌘，其他平台用 Ctrl。 */
export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** 快捷鍵的顯示文字，例如 `shortcutLabel(",")` → `Ctrl ,`。 */
export function shortcutLabel(key: string, mac = isMac()): string {
  return `${mac ? "⌘" : "Ctrl"} ${key}`;
}

/** Ctrl（macOS 為 ⌘）有沒有按著。 */
export function hasModifier(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return event.ctrlKey || event.metaKey;
}

const style: CSSProperties = {
  height: 16,
  padding: "0 5px",
  display: "inline-flex",
  alignItems: "center",
  whiteSpace: "nowrap",
  borderRadius: 4,
  border: "1px solid var(--o26292e)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  lineHeight: "14px",
  color: "var(--o8b9098)",
  pointerEvents: "none",
};

/** 快捷鍵提示（10px 等寬、1px 邊框）。`bare` 時不加邊框（選單項目右側）。 */
export function Kbd({ children, bare = false }: { children: string; bare?: boolean }) {
  if (bare)
    return (
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--o8b9098)" }}>
        {children}
      </span>
    );
  return <kbd style={style}>{children}</kbd>;
}
