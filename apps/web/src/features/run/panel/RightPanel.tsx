// 右側面板：任務、差異、預覽、終端機四個分頁（README「Right panel tabs」）。

import { ClipboardList, FileDiff, Globe, SquareTerminal } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { FluidList, fluidItem } from "../../../components/FluidList";
import { useT } from "../../../i18n";
import type { WorkspaceTab } from "../workspace/route-state";
import "./panel.css";

const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

const TAB_ICONS: Record<WorkspaceTab, ReactNode> = {
  task: <ClipboardList {...ICON} />,
  diff: <FileDiff {...ICON} />,
  preview: <Globe {...ICON} />,
  terminal: <SquareTerminal {...ICON} />,
};

const TABS: readonly WorkspaceTab[] = ["task", "diff", "preview", "terminal"];

export interface TabBadges {
  /** 變更的檔案數；在審查關卡時以警告色顯示。 */
  diff: { count: number; warn: boolean } | null;
  /** Preview 正在執行。 */
  preview: boolean;
}

interface RightPanelProps {
  tab: WorkspaceTab;
  onTab: (tab: WorkspaceTab) => void;
  badges: TabBadges;
  children: ReactNode;
}

export function RightPanel({ tab, onTab, badges, children }: RightPanelProps) {
  const t = useT();
  function onKeyDown(event: KeyboardEvent) {
    const index = TABS.indexOf(tab);
    const next =
      event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = TABS[(next + TABS.length) % TABS.length] as WorkspaceTab;
    onTab(target);
    document.getElementById(`rp-tab-${target}`)?.focus();
  }
  return (
    <div className="rp">
      <FluidList
        axis="x"
        inset={12}
        className="rp-tabs"
        role="tablist"
        aria-label={t.workspace.tabs.label}
        onKeyDown={onKeyDown}
      >
        {TABS.map((value) => {
          const selected = value === tab;
          const label = t.workspace.tabs[value];
          return (
            <button
              key={value}
              id={`rp-tab-${value}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="rp-tabpanel"
              tabIndex={selected ? 0 : -1}
              className="rp-tab"
              data-selected={selected}
              {...fluidItem}
              onClick={() => onTab(value)}
            >
              <span className="rp-tab-icon">{TAB_ICONS[value]}</span>
              <span className="rp-tab-label" data-label={label}>
                <span>{label}</span>
              </span>
              {value === "diff" && badges.diff && badges.diff.count > 0 && (
                <span className="rp-tab-badge" data-tone={badges.diff.warn ? "warn" : "muted"}>
                  {badges.diff.count}
                </span>
              )}
              {value === "preview" && badges.preview && (
                <span className="rp-tab-badge" data-tone="success" aria-hidden="true">
                  ●
                </span>
              )}
            </button>
          );
        })}
      </FluidList>
      <div id="rp-tabpanel" role="tabpanel" aria-labelledby={`rp-tab-${tab}`} className="rp-body">
        {children}
      </div>
    </div>
  );
}
