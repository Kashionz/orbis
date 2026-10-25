// 輸入框上方的執行環境列：Worktree 路徑（選單：檔案總管、終端機、VS Code、複製路徑、複製分支名稱）、
// 分支、經過時間、context 用量、費用。

import type { Run, RunUsage } from "@orbis/api-contract";
import { getDesktopBridge } from "@orbis/desktop/bridge";
import { useMutation } from "@tanstack/react-query";
import { Code, Copy, Folder, FolderOpen, GitBranch, SquareTerminal } from "lucide-react";
import { useRef, useState } from "react";
import { type MenuGroup, Popover } from "../../../components/Popover";
import { useToast } from "../../../components/Toast";
import { useT } from "../../../i18n";
import { useNow } from "../workspace/use-now";
import { contextUsage, elapsedMs, formatCost, formatElapsed, shortenPath } from "./run-meter";

const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

type PathAction = "explorer" | "terminal" | "editor" | "copy-path" | "copy-branch";

interface EnvBarProps {
  run: Run;
  usage: RunUsage;
  live: boolean;
  /** 一般瀏覽器中「在終端機開啟」改為切到終端機分頁。 */
  onOpenTerminalTab: () => void;
}

export function EnvBar({ run, usage, live, onOpenTerminalTab }: EnvBarProps) {
  const t = useT();
  const c = t.workspace.composer;
  const toast = useToast();
  const [bridge] = useState(() => getDesktopBridge());
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const now = useNow(1000, live);
  const elapsed = elapsedMs(run.startedAt, run.endedAt, now);
  const context = contextUsage(usage);
  const cost = formatCost(usage);
  const path = run.worktreePath;

  const openWith = useMutation({
    mutationFn: async (target: "editor" | "terminal") => {
      if (!bridge || !path) return;
      const result =
        target === "editor"
          ? await bridge.openWorktreeInEditor(path)
          : await bridge.openWorktreeInTerminal(path);
      if (!result.ok) throw new Error(result.message);
    },
    onError: (error) =>
      toast.show(`${c.openFailed}：${error instanceof Error ? error.message : ""}`),
  });

  function copy(text: string) {
    void navigator.clipboard?.writeText(text).then(
      () => toast.show(t.common.copied),
      () => undefined,
    );
  }

  function select(action: PathAction) {
    if (!path) return;
    switch (action) {
      case "terminal":
        if (bridge) openWith.mutate("terminal");
        else onOpenTerminalTab();
        return;
      case "editor":
        openWith.mutate("editor");
        return;
      case "copy-path":
        copy(path);
        return;
      case "copy-branch":
        if (run.branch) copy(run.branch);
        return;
      case "explorer":
        // TODO(backend, reveal-in-explorer)：Desktop bridge 還沒有在檔案總管開啟的方法
        return;
    }
  }

  const groups: MenuGroup<PathAction>[] = [
    {
      title: path ?? "",
      titleMono: true,
      items: [
        // 一般瀏覽器開不了本機的檔案總管與編輯器
        ...(bridge
          ? [
              {
                value: "explorer" as const,
                label: c.openInExplorer,
                icon: <FolderOpen {...ICON} />,
                // TODO(backend, reveal-in-explorer)：Desktop bridge 加上方法後開放
                disabled: true,
                disabledReason: t.common.notAvailableYet,
              },
            ]
          : []),
        { value: "terminal" as const, label: c.openInTerminal, icon: <SquareTerminal {...ICON} /> },
        ...(bridge
          ? [{ value: "editor" as const, label: c.openInEditor, icon: <Code {...ICON} /> }]
          : []),
      ],
    },
    {
      items: [
        { value: "copy-path", label: c.copyPath, icon: <Copy {...ICON} /> },
        ...(run.branch
          ? [{ value: "copy-branch" as const, label: c.copyBranch, icon: <GitBranch {...ICON} /> }]
          : []),
      ],
    },
  ];

  return (
    <div className="cp-env">
      <div className="cp-env-left">
        {path && (
          <button
            ref={anchorRef}
            type="button"
            className="cp-path"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`${c.worktree} ${path}`}
            data-tip={path}
            data-tip-mono=""
            data-open={open}
            onClick={() => setOpen((v) => !v)}
          >
            <Folder {...ICON} />
            <span className="cp-ellipsis">{shortenPath(path)}</span>
          </button>
        )}
        {run.branch && (
          <span className="cp-branch" data-tip={c.branch}>
            <GitBranch {...ICON} />
            <span className="cp-ellipsis">{run.branch}</span>
          </span>
        )}
      </div>
      <div className="cp-env-right">
        {elapsed !== null && (
          <span data-tip={c.runId(run.id)} data-testid="run-elapsed">
            {formatElapsed(elapsed)}
          </span>
        )}
        {context && (
          <span
            className="cp-context"
            data-tip={c.contextUsed(context.detail)}
            data-testid="run-usage"
          >
            <span className="cp-context-bar">
              <span
                className="cp-context-fill"
                data-warn={context.warn}
                style={{ width: `${context.percent}%` }}
              />
            </span>
            {context.percent}%
          </span>
        )}
        {cost && (
          <span className="cp-cost" data-tip={c.runCost}>
            {cost}
          </span>
        )}
      </div>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        groups={groups}
        onSelect={select}
        label={c.worktree}
        minWidth={240}
        selectable={false}
      />
    </div>
  );
}
