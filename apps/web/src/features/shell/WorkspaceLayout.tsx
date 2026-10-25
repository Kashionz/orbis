// 工作區的兩欄：主欄（52px 標題列＋內容）與右側面板，中間是可拖曳的分割線。
// 面板寬度 = split × 工作區寬度（26%–62%）；雙擊分割線重設為 42%，←→ 每次 ±2%。

import { type ReactNode, useRef } from "react";
import { Splitter } from "../../components/Splitter";
import { useT } from "../../i18n";
import {
  PANEL_SPLIT_DEFAULT,
  PANEL_SPLIT_MAX,
  PANEL_SPLIT_MIN,
  PANEL_SPLIT_STEP,
  usePanel,
} from "./use-panel";
import "./shell.css";

interface WorkspaceLayoutProps {
  /** 主欄的標題列（52px）。 */
  header: ReactNode;
  /** 右側面板的內容（含分頁列）；null 時不顯示面板。面板開關由 `usePanel()` 控制。 */
  panel: ReactNode | null;
  /** 主欄的內容（事件串流、輸入框）。 */
  children: ReactNode;
}

export function WorkspaceLayout({ header, panel, children }: WorkspaceLayoutProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const { open, split, setSplit } = usePanel();
  const showPanel = open && panel !== null;

  return (
    <div ref={containerRef} className="ws-layout">
      <section className="ws-main">
        <header className="ws-header">{header}</header>
        <div className="ws-content">{children}</div>
      </section>
      {showPanel && (
        <>
          <div className="ws-splitter-slot">
            <Splitter
              edge="left"
              label={t.shell.resizePanel}
              value={split}
              min={PANEL_SPLIT_MIN}
              max={PANEL_SPLIT_MAX}
              defaultValue={PANEL_SPLIT_DEFAULT}
              step={PANEL_SPLIT_STEP}
              rightIncreases={false}
              valueText={`${Math.round(split * 100)}%`}
              onChange={setSplit}
              valueFromPointer={(clientX) => {
                const rect = containerRef.current?.getBoundingClientRect();
                if (!rect || rect.width === 0) return split;
                return (rect.right - clientX) / rect.width;
              }}
            />
          </div>
          <aside className="ws-panel" style={{ width: `${(split * 100).toFixed(1)}%` }}>
            {panel}
          </aside>
        </>
      )}
    </div>
  );
}

/** 看板、待我處理等沒有右側面板的頁面的主欄。 */
export function MainColumn({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={["main-column", className].filter(Boolean).join(" ")}>{children}</main>;
}
