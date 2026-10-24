import type { RunEvent } from "@orbis/api-contract";
import type { EventKind, RunStatus } from "@orbis/protocol";
import { describe, expect, it } from "vitest";
import { applyEvents, EMPTY_TIMELINE, type TimelineItem } from "../timeline";
import {
  buildStream,
  isTurnFinished,
  type StreamContext,
  streamTail,
  withExtras,
} from "./stream-model";

/** 依序產生 Event；`gaps[i]` 是第 i 筆和前一筆相差的秒數（預設 1 秒）。 */
function timeline(kinds: EventKind[], gaps: number[] = []): TimelineItem[] {
  let at = Date.UTC(2026, 9, 25, 8, 0, 0);
  const events: RunEvent[] = kinds.map((event, index) => {
    at += (gaps[index] ?? 1) * 1000;
    return { runId: "run-1", seq: index + 1, ts: new Date(at).toISOString(), event };
  });
  return [...applyEvents(EMPTY_TIMELINE, events).items];
}

const ctx = (status: RunStatus | null, extra: Partial<StreamContext> = {}): StreamContext => ({
  status,
  gate: null,
  autoExpandTools: false,
  ...extra,
});

const text = (value: string): EventKind => ({
  kind: "message_chunk",
  content: { type: "text", text: value },
});
const thought = (value: string): EventKind => ({ kind: "thought_chunk", text: value });
const prompt = (value: string): EventKind => ({
  kind: "prompt_submitted",
  source: "user",
  prompt: [{ type: "text", text: value }],
});
const status = (value: RunStatus, gate: "plan" | "review" | null = null): EventKind => ({
  kind: "status_changed",
  status: value,
  gate,
  message: null,
});
function tool(
  id: string,
  kind: "read" | "search" | "edit" | "execute",
  state: "pending" | "in_progress" | "completed" | "failed" = "completed",
  command?: string,
): EventKind {
  return {
    kind: "tool_call",
    tool_call_id: id,
    title: `${kind} ${id}`,
    tool_kind: kind,
    status: state,
    content: command
      ? [
          {
            type: "terminal",
            terminal_id: `term-${id}`,
            command,
            output: { type: "inline", text: "" },
            exit_code: null,
          },
        ]
      : [],
    locations: [{ path: `src/${id}.ts`, line: null }],
  };
}
const permission = (id: string, toolCallId: string | null): EventKind => ({
  kind: "permission_request",
  request_id: id,
  tool_call_id: toolCallId,
  title: "執行指令",
  purpose: "tool",
  options: [
    { option_id: "allow", name: "允許", kind: "allow_once" },
    { option_id: "reject", name: "拒絕", kind: "reject_once" },
  ],
});
const verify = (id: string, outcome: "passed" | "failed" | "error"): EventKind => ({
  kind: "verification_result",
  verification_id: "v1",
  judged_by_run_id: null,
  attempt: 1,
  criterion_id: id,
  outcome,
  summary: "",
  evidence: [],
});

describe("buildStream：工具群組", () => {
  it("連續的 tool call 合成一個群組，依分類計數與決定標題", () => {
    const items = timeline(
      [tool("a", "read"), tool("b", "read"), tool("c", "search"), tool("d", "edit")],
      [0, 2, 3, 4],
    );
    const [group] = buildStream(items, ctx("running"));
    expect(group).toMatchObject({
      kind: "tool_group",
      counts: { read: 2, search: 1, edit: 1, execute: 0, other: 0 },
      label: "edited",
      running: false,
      failed: 0,
      durationSeconds: 9,
      defaultOpen: false,
    });
  });

  it("有進行中的 tool call 時標題是工作中，失敗的會計數", () => {
    const items = timeline([tool("a", "execute", "failed"), tool("b", "read", "in_progress")]);
    const [group] = buildStream(items, ctx("running"));
    expect(group).toMatchObject({ label: "working", running: true, failed: 1 });
  });

  it("只有讀取與搜尋時是查看了程式碼，只有執行時是執行了指令", () => {
    const viewed = buildStream(timeline([tool("a", "read"), tool("b", "search")]), ctx("running"));
    const executed = buildStream(timeline([tool("a", "execute")]), ctx("running"));
    expect(viewed[0]).toMatchObject({ label: "viewed" });
    expect(executed[0]).toMatchObject({ label: "executed" });
  });

  it("權限請求把群組切開，細節取自觸發請求的 tool call 的指令", () => {
    const items = timeline([
      tool("a", "read"),
      tool("b", "execute", "pending", "pnpm test"),
      permission("p1", "b"),
      tool("c", "read"),
    ]);
    const stream = buildStream(items, ctx("awaiting_permission"));
    expect(stream.map((s) => s.kind)).toEqual(["tool_group", "permission", "tool_group"]);
    expect(stream[1]).toMatchObject({ kind: "permission", detail: "pnpm test" });
  });

  it("沒有指令時細節是 tool call 碰到的檔案；找不到 tool call 時沒有細節", () => {
    const stream = buildStream(
      timeline([tool("a", "read"), permission("p1", "a"), permission("p2", null)]),
      ctx("awaiting_permission"),
    );
    expect(stream[1]).toMatchObject({ detail: "src/a.ts" });
    expect(stream[2]).toMatchObject({ detail: null });
  });

  it("自動展開工具步驟時，進行中與最後的群組預設展開", () => {
    const items = timeline([tool("a", "read"), text("中間"), tool("b", "read"), text("最後")]);
    const off = buildStream(items, ctx("running"));
    const on = buildStream(items, ctx("running", { autoExpandTools: true }));
    expect(
      off
        .filter((s) => s.kind === "tool_group")
        .map((s) => s.kind === "tool_group" && s.defaultOpen),
    ).toEqual([false, false]);
    expect(
      on
        .filter((s) => s.kind === "tool_group")
        .map((s) => s.kind === "tool_group" && s.defaultOpen),
    ).toEqual([false, true]);
  });
});

describe("buildStream：驗收群組", () => {
  it("連續的結果合成一個群組，verification_completed 併入群組", () => {
    const items = timeline([
      status("verifying"),
      verify("a1", "passed"),
      verify("a2", "passed"),
      { kind: "verification_completed", verification_id: "v1", attempt: 1, outcome: "passed" },
    ]);
    const stream = buildStream(items, ctx("verifying"));
    expect(stream.map((s) => s.kind)).toEqual(["status", "verification_group"]);
    expect(stream[1]).toMatchObject({
      passed: 2,
      failed: 0,
      completed: "passed",
      defaultOpen: false,
    });
  });

  it("有失敗或無法判定時預設展開", () => {
    const stream = buildStream(
      timeline([verify("a1", "passed"), verify("a2", "error")]),
      ctx("verifying"),
    );
    expect(stream[0]).toMatchObject({ passed: 1, failed: 1, completed: null, defaultOpen: true });
  });
});

describe("buildStream：頭像列", () => {
  it("prompt 一律有人的頭像列，Agent 只在換人後的第一個項目有", () => {
    const items = timeline([
      status("running"),
      prompt("請修正"),
      thought("先看看"),
      tool("a", "read"),
      text("改好了"),
      prompt("再補測試"),
      text("好"),
    ]);
    const heads = buildStream(items, ctx("running")).map((s) => s.head?.actor ?? null);
    expect(heads).toEqual([null, "user", "agent", null, null, "user", "agent"]);
  });

  it("狀態列與系統事件不會打斷 Agent 的段落", () => {
    const items = timeline([text("開始"), status("verifying"), text("繼續")]);
    const heads = buildStream(items, ctx("running")).map((s) => s.head?.actor ?? null);
    expect(heads).toEqual(["agent", null, null]);
  });
});

describe("buildStream：思考", () => {
  it("思考的秒數取到下一個項目；最後一個項目而且執行中時是 live", () => {
    const items = timeline([thought("想"), text("好"), thought("再想")], [0, 7, 1]);
    const stream = buildStream(items, ctx("running"));
    expect(stream[0]).toMatchObject({ kind: "thought", seconds: 7, live: false });
    expect(stream[2]).toMatchObject({ kind: "thought", seconds: null, live: true });
  });

  it("Run 不在執行中時最後的思考不是 live", () => {
    const stream = buildStream(timeline([thought("想")]), ctx("awaiting_gate", { gate: "review" }));
    expect(stream[0]).toMatchObject({ live: false });
  });
});

describe("buildStream：狀態列", () => {
  it("不顯示等待權限回覆與回覆後的繼續執行", () => {
    const items = timeline([
      status("running"),
      status("awaiting_permission"),
      status("running"),
      status("completed"),
    ]);
    const shown = buildStream(items, ctx("completed")).map(
      (s) => s.kind === "status" && s.item.status,
    );
    expect(shown).toEqual(["running", "completed"]);
  });

  it("回合結束後緊接著 Verification 時，只顯示驗證；Verification 結束後的審查關卡照常顯示", () => {
    const items = timeline([
      status("running"),
      status("awaiting_gate", "review"),
      status("verifying"),
      status("awaiting_gate", "review"),
    ]);
    const shown = buildStream(items, ctx("awaiting_gate", { gate: "review" })).map(
      (s) => s.kind === "status" && `${s.item.status}:${s.item.gate ?? ""}`,
    );
    expect(shown).toEqual(["running:", "verifying:", "awaiting_gate:review"]);
  });
});

describe("streamTail", () => {
  const turn = [
    prompt("請修正"),
    thought("想"),
    text("改好了。"),
    status("awaiting_gate", "review"),
  ];

  it("審查關卡時顯示在最後一則回覆底下，工作時間從 prompt 算起", () => {
    const items = timeline(turn, [0, 2, 40, 1]);
    const context = ctx("awaiting_gate", { gate: "review" });
    const tail = streamTail(buildStream(items, context), context, items);
    expect(tail).toMatchObject({
      messageKey: "message_chunk-3",
      text: "改好了。",
      turnSeconds: 42,
    });
  });

  it("執行中、計畫關卡、還有沒回覆的權限請求時不顯示", () => {
    const items = timeline(turn);
    for (const context of [ctx("running"), ctx("awaiting_gate", { gate: "plan" })]) {
      expect(streamTail(buildStream(items, context), context, items)).toBeNull();
    }
    const pending = timeline([...turn, permission("p1", null)]);
    const context = ctx("completed");
    expect(streamTail(buildStream(pending, context), context, pending)).toBeNull();
  });

  it("最後一則回覆之後人又送出 prompt 時不顯示", () => {
    const items = timeline([...turn, prompt("再改一下")]);
    const context = ctx("canceled");
    expect(streamTail(buildStream(items, context), context, items)).toBeNull();
  });

  it("沒有 prompt 時從第一個項目算起", () => {
    const items = timeline([text("開始"), text("x"), status("completed")], [0, 5, 1]);
    // 連續片段合併成一則訊息
    const context = ctx("completed");
    expect(streamTail(buildStream(items, context), context, items)).toMatchObject({
      turnSeconds: 5,
    });
  });
});

describe("isTurnFinished", () => {
  it("只有審查關卡與終止狀態算結束", () => {
    expect(isTurnFinished("awaiting_gate", "review", [])).toBe(true);
    expect(isTurnFinished("awaiting_gate", "plan", [])).toBe(false);
    expect(isTurnFinished("failed", null, [])).toBe(true);
    expect(isTurnFinished("rate_limited", null, [])).toBe(false);
    expect(isTurnFinished(null, null, [])).toBe(false);
  });
});

describe("withExtras", () => {
  const items = timeline([text("開始"), status("completed")], [0, 60]);
  const stream = buildStream(items, ctx("completed"));
  const [first] = items;
  const later = (seconds: number) =>
    new Date(Date.parse(first?.ts ?? "") + seconds * 1000).toISOString();

  it("切換紀錄與 PR 依時間插入；同一時間放在原本的項目之後", () => {
    const merged = withExtras(
      stream,
      [
        {
          ts: later(30),
          memberId: "me",
          kind: "policy",
          agent: null,
          model: null,
          effort: null,
          permissionPolicy: "manual",
        },
      ],
      {
        number: 12,
        url: "https://github.com/acme/demo/pull/12",
        state: "merged",
        runId: "run-1",
        openedAt: later(60),
        mergedAt: later(120),
      },
    );
    expect(merged.map((s) => s.kind)).toEqual([
      "message",
      "switch",
      "status",
      "pull_request",
      "pull_request",
    ]);
    expect(merged.at(-1)).toMatchObject({ merged: true });
  });

  it("沒有紀錄時原樣回傳", () => {
    expect(withExtras(stream, [], null)).toEqual(stream);
  });
});
