// 終端機分頁（純函式）：Run 中 Agent 執行過的指令，依時間排成區塊。
// 後端沒有互動式終端機；這裡顯示的是 tool call 的 terminal 內容（指令、輸出、結束碼）。

import type { TextBody } from "@orbis/protocol";
import type { TimelineItem } from "../timeline";

/** 終端機分頁的 shell 切換（只影響提示字元）。 */
export const TERMINAL_SHELLS = ["PowerShell", "cmd", "Git Bash"] as const;
export type TerminalShell = (typeof TERMINAL_SHELLS)[number];

export function shellPrompt(shell: TerminalShell): string {
  switch (shell) {
    case "PowerShell":
      return "PS>";
    case "cmd":
      return "C:\\>";
    default:
      return "$";
  }
}

export interface TerminalBlock {
  key: string;
  /** tool call 的 id（從終端機分頁跳回事件串流用）。 */
  toolCallId: string;
  command: string;
  /** 內嵌的輸出，或存在 blob 的大輸出。 */
  output: TextBody;
  /** 還在執行時為 null。 */
  exitCode: number | null;
  running: boolean;
  ts: string;
}

/** Run 中執行過的指令；一個 tool call 可能有多段 terminal 內容。 */
export function terminalBlocks(items: readonly TimelineItem[]): TerminalBlock[] {
  const blocks: TerminalBlock[] = [];
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    const running = item.status === "pending" || item.status === "in_progress";
    item.content.forEach((content, index) => {
      if (content.type !== "terminal") return;
      blocks.push({
        key: `${item.key}-${index}`,
        toolCallId: item.toolCallId,
        command: content.command ?? item.title,
        output: content.output,
        exitCode: content.exit_code,
        running: running && content.exit_code === null,
        ts: item.ts,
      });
    });
  }
  return blocks;
}

/** 複製一個區塊：指令加上內嵌的輸出。 */
export function blockCopyText(block: TerminalBlock): string {
  return block.output.type === "inline" && block.output.text !== ""
    ? `${block.command}\n${block.output.text}`
    : block.command;
}

/** 時鐘時間 `HH:MM:SS`（依使用者的時區）。 */
export function clockTime(ts: string): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
