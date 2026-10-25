// 終端機分頁：Run 中 Agent 執行過的指令（提示字元＋指令、時間、複製、輸出、結束碼）。
// shell 的切換只換提示字元，存在設定的「預設終端」。

import type { Run } from "@orbis/api-contract";
import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { blobTextQuery } from "../../../api/resources";
import { Segmented } from "../../../components/Segmented";
import { useToast } from "../../../components/Toast";
import { useT } from "../../../i18n";
import { terminalShellPreference, usePreferences } from "../../../lib/preferences";
import type { TimelineItem } from "../timeline";
import {
  blockCopyText,
  clockTime,
  shellPrompt,
  TERMINAL_SHELL_NAMES,
  type TerminalBlock,
  type TerminalShell,
  terminalBlocks,
} from "./terminal-blocks";

export function TerminalTab({ run, items }: { run: Run | null; items: readonly TimelineItem[] }) {
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
