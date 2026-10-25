// 終端機分頁：
// - 「代理指令」：Run 中 Agent 執行過的指令（提示字元＋指令、時間、複製、輸出、結束碼）。shell 的切換只換
//   提示字元，存在設定的「預設終端」。
// - 互動式終端機（ADR-0014）：在 Worktree 中開 shell，最多同時 TERMINAL_MAX_PER_RUN 個；關閉分頁就關閉終端機。
//   誰能開由 Server 判斷（Local Runner 的擁有者；Team Runner 限 Admin 且 Team 設定打開）。

import { type Run, TERMINAL_MAX_PER_RUN } from "@orbis/api-contract";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Copy, Plus, X } from "lucide-react";
import { useState } from "react";
import { blobTextQuery } from "../../../api/resources";
import { ErrorText } from "../../../components/ErrorText";
import { Segmented } from "../../../components/Segmented";
import { useToast } from "../../../components/Toast";
import { useT } from "../../../i18n";
import { terminalShellPreference, usePreferences } from "../../../lib/preferences";
import type { TimelineItem } from "../timeline";
import { openRunTerminal } from "../workspace-api";
import { InteractiveTerminal } from "./InteractiveTerminal";
import {
  blockCopyText,
  clockTime,
  shellPrompt,
  TERMINAL_SHELL_NAMES,
  type TerminalBlock,
  type TerminalShell,
  terminalBlocks,
} from "./terminal-blocks";

interface Session {
  id: string;
  wsUrl: string;
  /** 分頁上的編號（從 1 開始）。 */
  number: number;
}

export function TerminalTab({
  run,
  items,
  canOpen = false,
}: {
  run: Run | null;
  items: readonly TimelineItem[];
  /** 能不能開互動式終端機（實際權限由 Server 判斷）。 */
  canOpen?: boolean;
}) {
  const t = useT();
  const w = t.workspace.terminal;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<string>("agent");
  const [counter, setCounter] = useState(0);
  const open = useMutation({
    mutationFn: () => {
      if (!run) throw new Error("沒有 Run");
      return openRunTerminal(run.id, { cols: 80, rows: 24 });
    },
    onSuccess: (created) => {
      const number = counter + 1;
      setCounter(number);
      setSessions((current) => [
        ...current,
        { id: created.terminalId, wsUrl: created.wsUrl, number },
      ]);
      setActive(created.terminalId);
    },
  });
  const close = (id: string) => {
    setSessions((current) => current.filter((s) => s.id !== id));
    setActive((current) => (current === id ? "agent" : current));
  };

  return (
    <div className="rp-term-wrap">
      <div className="rp-term-tabs" role="tablist" aria-label={w.tabs}>
        <button
          type="button"
          role="tab"
          className="rp-term-tab"
          aria-selected={active === "agent"}
          onClick={() => setActive("agent")}
        >
          {w.agentCommands}
        </button>
        {sessions.map((session) => (
          <span key={session.id} className="rp-term-tab" data-selected={active === session.id}>
            <button
              type="button"
              role="tab"
              className="rp-term-tab-label"
              aria-selected={active === session.id}
              onClick={() => setActive(session.id)}
            >
              {w.session(session.number)}
            </button>
            <button
              type="button"
              className="rp-term-tab-close"
              aria-label={w.closeSession(session.number)}
              onClick={() => close(session.id)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        {canOpen && run && sessions.length < TERMINAL_MAX_PER_RUN && (
          <button
            type="button"
            className="rp-term-new"
            aria-label={w.newSession}
            data-tip={w.newSession}
            disabled={open.isPending}
            onClick={() => open.mutate()}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <ErrorText error={open.error} />
      {active === "agent" && <AgentCommands run={run} items={items} />}
      {sessions.map((session) => (
        <div key={session.id} className="rp-term-session" hidden={active !== session.id}>
          <InteractiveTerminal
            wsUrl={session.wsUrl}
            active={active === session.id}
            onEnd={() => undefined}
          />
        </div>
      ))}
    </div>
  );
}

/** Agent 執行過的指令。 */
function AgentCommands({ run, items }: { run: Run | null; items: readonly TimelineItem[] }) {
  const t = useT();
  const { terminalShell } = usePreferences();
  const blocks = terminalBlocks(items);
  const prompt = shellPrompt(terminalShell);
  return (
    <div className="rp-term">
      <div className="rp-toolbar">
        <Segmented<TerminalShell>
          label={t.workspace.terminal.shell}
          value={terminalShell}
          onChange={(value) => terminalShellPreference.set(value)}
          options={(Object.keys(TERMINAL_SHELL_NAMES) as TerminalShell[]).map((value) => ({
            value,
            label: TERMINAL_SHELL_NAMES[value],
          }))}
        />
        {run?.worktreePath && (
          <span className="rp-mono-muted rp-ellipsis" data-tip={run.worktreePath} data-tip-mono="">
            {run.worktreePath}
          </span>
        )}
      </div>
      <div className="rp-term-body">
        {blocks.length === 0 && <span className="rp-muted">{t.workspace.terminal.empty}</span>}
        {blocks.map((block) => (
          <TerminalBlockView key={block.key} block={block} prompt={prompt} />
        ))}
      </div>
    </div>
  );
}

function TerminalBlockView({ block, prompt }: { block: TerminalBlock; prompt: string }) {
  const t = useT();
  const w = t.workspace.terminal;
  const toast = useToast();
  const blob = useQuery({
    ...blobTextQuery(block.output.type === "blob" ? block.output.blob_id : ""),
    enabled: block.output.type === "blob",
  });
  const output = block.output.type === "inline" ? block.output.text : (blob.data ?? "");
  return (
    <div className="rp-term-block" data-tool-call={block.toolCallId}>
      <div className="rp-term-head">
        <span className="rp-term-cmd">
          <span className="rp-term-prompt">{prompt} </span>
          {block.command}
        </span>
        <span className="rp-term-time">{clockTime(block.ts)}</span>
        <button
          type="button"
          className="rp-term-copy"
          aria-label={w.copy}
          data-tip={w.copy}
          onClick={() =>
            void navigator.clipboard?.writeText(blockCopyText(block)).then(
              () => toast.show(t.common.copied),
              () => undefined,
            )
          }
        >
          <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {output && <div className="rp-term-out">{output}</div>}
      {block.exitCode !== null && (
        <div className="rp-term-exit" data-failed={block.exitCode !== 0}>
          {w.exitCode(block.exitCode)}
        </div>
      )}
      {block.running && <div className="rp-term-running">{w.running}</div>}
    </div>
  );
}
