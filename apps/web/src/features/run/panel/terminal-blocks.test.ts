import type { RunEvent } from "@orbis/api-contract";
import type { EventKind } from "@orbis/protocol";
import { describe, expect, it } from "vitest";
import { applyEvents, EMPTY_TIMELINE } from "../timeline";
import { blockCopyText, shellPrompt, terminalBlocks } from "./terminal-blocks";

function items(kinds: EventKind[]) {
  const events: RunEvent[] = kinds.map((event, index) => ({
    runId: "run-1",
    seq: index + 1,
    ts: new Date(Date.UTC(2026, 9, 25, 8, 0, index)).toISOString(),
    event,
    actorMemberId: null,
  }));
  return applyEvents(EMPTY_TIMELINE, events).items;
}

const execute = (
  id: string,
  status: "in_progress" | "completed",
  command: string | null,
  output: string,
  exit: number | null,
): EventKind => ({
  kind: "tool_call",
  tool_call_id: id,
  title: `執行 ${id}`,
  tool_kind: "execute",
  status,
  content: [
    {
      type: "terminal",
      terminal_id: `term-${id}`,
      command,
      output: { type: "inline", text: output },
      exit_code: exit,
    },
  ],
  locations: [],
});

describe("terminalBlocks", () => {
  it("依時間列出 terminal 內容；更新後的輸出與結束碼取代原本的", () => {
    const blocks = terminalBlocks(
      items([
        execute("t1", "in_progress", "pnpm test", " RUN", null),
        { kind: "message_chunk", content: { type: "text", text: "等一下" } },
        execute("t1", "completed", "pnpm test", " ✓ 3 passed", 0),
        execute("t2", "in_progress", null, "", null),
      ]),
    );
    expect(blocks).toMatchObject([
      { toolCallId: "t1", command: "pnpm test", exitCode: 0, running: false },
      { toolCallId: "t2", command: "執行 t2", exitCode: null, running: true },
    ]);
    expect(blockCopyText(blocks[0] as (typeof blocks)[number])).toBe("pnpm test\n ✓ 3 passed");
  });

  it("沒有 terminal 內容的 tool call 不列出", () => {
    expect(
      terminalBlocks(
        items([
          {
            kind: "tool_call",
            tool_call_id: "r",
            title: "讀取",
            tool_kind: "read",
            status: "completed",
            content: [{ type: "text", text: "內容" }],
            locations: [],
          },
        ]),
      ),
    ).toEqual([]);
  });

  it("shell 的提示字元", () => {
    expect(shellPrompt("powershell")).toBe("PS>");
    expect(shellPrompt("cmd")).toBe("C:\\>");
    expect(shellPrompt("git-bash")).toBe("$");
  });
});
