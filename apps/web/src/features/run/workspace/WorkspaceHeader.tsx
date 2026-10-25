// 工作區標題列：狀態點、Task Key、標題、Run 狀態、中止執行、分享、面板切換。依寬度逐步收合
// （header-layout.ts）；只剩圖示的按鈕一定有 aria-label 與 Tooltip。

import type { Run, Task } from "@orbis/api-contract";
import type { GateKind, RunStatus } from "@orbis/protocol";
import { Link } from "@tanstack/react-router";
import { CornerLeftUp, PanelRight, Square } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useElementWidth } from "../../../components/hooks";
import { StatusDot } from "../../../components/StatusDot";
import { useLanguage, useT } from "../../../i18n";
import { isRunLive, runTone, TONE_COLOR, taskTone } from "../run-tone";
import { runStatusLabel } from "../stream/StreamRows";
import { headerLayout } from "./header-layout";

const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

interface WorkspaceHeaderProps {
  task: Task;
  run: Run | null;
  status: RunStatus | null;
  gate: GateKind | null;
  /** 有等待目前 Member 處理的項目。 */
  needs: boolean;
  canCancel: boolean;
  cancelling: boolean;
  onCancel: () => void;
  canRedispatch: boolean;
  onRedispatch: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** U1 的分享按鈕（頭像堆疊＋分享），依寬度收合。 */
  share?: (layout: { avatars: boolean; label: boolean }) => ReactNode;
}

export function WorkspaceHeader({
  task,
  run,
  status,
  gate,
  needs,
  canCancel,
  cancelling,
  onCancel,
  canRedispatch,
  onRedispatch,
  panelOpen,
  onTogglePanel,
  share,
}: WorkspaceHeaderProps) {
  const t = useT();
  const h = t.workspace.header;
  const language = useLanguage();
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const layout = headerLayout(width || null, language);
  const live = status !== null && isRunLive(status) && !needs;
  const dotColor = needs ? TONE_COLOR.warn : TONE_COLOR[taskTone(task.status)];

  return (
    <div ref={ref} className="wk-header" style={{ gap: layout.gap }}>
      <span className="wk-header-dot">
        <StatusDot color={dotColor} live={live} size={live ? 6 : 7} />
      </span>
      <span className="wk-header-key">{task.key}</span>
      <h1
        className="wk-header-title"
        style={{ minWidth: layout.titleMinWidth }}
        data-tip={task.title}
      >
        {task.title}
      </h1>
      {run && status && (
        <span
          className="wk-header-status"
          style={{ color: TONE_COLOR[runTone(status)] }}
          data-testid="run-status"
        >
          {runStatusLabel(t, status, gate)}
        </span>
      )}
      {run?.parentRunId && (
        <Link
          to="/runs/$runId"
          params={{ runId: run.parentRunId }}
          className="wk-header-parent"
          aria-label={h.parentRun}
          data-tip={h.parentRun}
        >
          <CornerLeftUp {...ICON} />
          {layout.wide && h.childRun}
        </Link>
      )}
      <span className="wk-header-spacer" />
      {canCancel && (
        <button
          type="button"
          className="wk-header-cancel"
          aria-label={h.cancelRun}
          data-tip={h.cancelRun}
          disabled={cancelling}
          onClick={onCancel}
        >
          <Square {...ICON} />
          {layout.wide && h.cancelRun}
        </button>
      )}
      {canRedispatch && (
        <button type="button" className="o-btn" data-variant="primary" onClick={onRedispatch}>
          {h.redispatch}
        </button>
      )}
      {share?.({ avatars: layout.wide, label: layout.shareLabel })}
      <button
        type="button"
        className="wk-header-panel"
        aria-label={panelOpen ? h.hidePanel : h.showPanel}
        aria-pressed={panelOpen}
        data-tip={panelOpen ? h.hidePanel : h.showPanel}
        onClick={onTogglePanel}
      >
        <PanelRight {...ICON} />
      </button>
    </div>
  );
}
