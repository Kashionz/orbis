import type { RunEvent } from "@orbis/api-contract";
import type { EventKind } from "@orbis/protocol";
import { describe, expect, it } from "vitest";
import { CONFIG_PATH, generateLargeRun, m1FirstTurnEvents } from "../../mocks/scripts";
import { applyEvents, EMPTY_TIMELINE, missingSeq, type Timeline } from "./timeline";

function events(...kinds: EventKind[]): RunEvent[] {
  return kinds.map((event, index) => ({
    runId: "run-1",
    seq: index + 1,
    ts: at(index),
    event,
  }));
}

const text = (value: string): EventKind => ({
  kind: "message_chunk",
  content: { type: "text", text: value },
});

/** `events()` 第 `index` 筆（從 0 開始）的時間。 */
const at = (index: number) => new Date(Date.UTC(2026, 9, 23, 8, 0, index)).toISOString();

function replay(list: readonly RunEvent[]): Timeline {
  return applyEvents(EMPTY_TIMELINE, list);
}

/** 只比較畫面會用到的部分（暫存與索引不比）。 */
function rendered(timeline: Timeline) {
  return {
    items: timeline.items,
    usage: timeline.usage,
    status: timeline.status,
    gate: timeline.gate,
    lastSeq: timeline.lastSeq,
  };
}

describe("applyEvents：訊息與思考", () => {
  it("連續的訊息片段合併成一則訊息", () => {
    const timeline = replay(events(text("你"), text("好"), text("！")));
    expect(timeline.items).toEqual([
      {
        key: "message_chunk-1",
        seq: 1,
        ts: at(0),
        lastTs: at(2),
        type: "message",
        blocks: [{ type: "text", text: "你好！" }],
      },
    ]);
  });

  it("中間有其他 Event 時分成兩則訊息", () => {
    const timeline = replay(
      events(text("a"), { kind: "thought_chunk", text: "想一下" }, text("b")),
    );
    expect(timeline.items.map((item) => item.type)).toEqual(["message", "thought", "message"]);
  });

  it("非文字的區塊不與文字合併", () => {
    const timeline = replay(
      events(
        text("看這個連結："),
        { kind: "message_chunk", content: { type: "resource_link", uri: "file:///a", name: "a" } },
        text("結束"),
      ),
    );
    const [message] = timeline.items;
    expect(message?.type === "message" && message.blocks.map((block) => block.type)).toEqual([
      "text",
      "resource_link",
      "text",
    ]);
  });

  it("連續的思考片段合併", () => {
    const timeline = replay(
      events({ kind: "thought_chunk", text: "先" }, { kind: "thought_chunk", text: "看看" }),
    );
    expect(timeline.items).toEqual([
      {
        key: "thought_chunk-1",
        seq: 1,
        ts: at(0),
        lastTs: at(1),
        type: "thought",
        text: "先看看",
      },
    ]);
  });
});

describe("applyEvents：tool call", () => {
  const created: EventKind = {
    kind: "tool_call",
    tool_call_id: "t1",
    title: "編輯 README.md",
    tool_kind: "edit",
    status: "pending",
    content: [{ type: "text", text: "舊內容" }],
    locations: [{ path: "README.md", line: 1 }],
  };

  it("後續 Event 就地更新：null 沿用前值，有值整個取代", () => {
    const timeline = replay(
      events(created, text("中間的訊息"), {
        kind: "tool_call",
        tool_call_id: "t1",
        title: null,
        tool_kind: null,
        status: "completed",
        content: [{ type: "text", text: "新內容" }],
        locations: null,
      }),
    );
    expect(timeline.items).toHaveLength(2);
    expect(timeline.items[0]).toEqual({
      key: "tool_call-t1",
      seq: 1,
      ts: at(0),
      lastTs: at(2),
      type: "tool_call",
      toolCallId: "t1",
      title: "編輯 README.md",
      toolKind: "edit",
      status: "completed",
      content: [{ type: "text", text: "新內容" }],
      locations: [{ path: "README.md", line: 1 }],
    });
  });

  it("第一筆缺欄位時用預設值", () => {
    const timeline = replay(
      events({
        kind: "tool_call",
        tool_call_id: "t2",
        title: null,
        tool_kind: null,
        status: null,
        content: null,
        locations: null,
      }),
    );
    expect(timeline.items[0]).toMatchObject({ title: "t2", toolKind: "other", status: "pending" });
  });
});

describe("applyEvents：權限請求、狀態、用量與錯誤", () => {
  it("permission_resolved 更新對應的權限請求", () => {
    const timeline = replay(
      events(
        {
          kind: "permission_request",
          request_id: "p1",
          tool_call_id: null,
          title: "執行 rm",
          options: [
            { option_id: "allow", name: "允許", kind: "allow_once" },
            { option_id: "reject", name: "拒絕", kind: "reject_once" },
          ],
          purpose: "tool",
        },
        { kind: "permission_resolved", request_id: "p1", selected_option_id: "reject" },
        { kind: "permission_resolved", request_id: "不存在", selected_option_id: null },
      ),
    );
    expect(timeline.items).toHaveLength(1);
    expect(timeline.items[0]).toMatchObject({
      type: "permission",
      resolved: { selectedOptionId: "reject" },
    });
  });

  it("權限請求保留用途；沒有 purpose 的舊 Event 視為一般的 tool call", () => {
    const options = [{ option_id: "ok", name: "核准", kind: "allow_once" as const }];
    const legacy = {
      kind: "permission_request",
      request_id: "p2",
      tool_call_id: null,
      title: "舊的請求",
      options,
    } as unknown as EventKind;
    const timeline = replay(
      events(
        {
          kind: "permission_request",
          request_id: "p1",
          tool_call_id: null,
          title: `${CONFIG_PATH} 的 setup`,
          options,
          purpose: "config_trust",
        },
        legacy,
      ),
    );
    expect(timeline.items.map((item) => item.type === "permission" && item.purpose)).toEqual([
      "config_trust",
      "tool",
    ]);
  });

  it("run_diff 在時間軸中只顯示變更的檔案數", () => {
    const timeline = replay(
      events({
        kind: "run_diff",
        base_commit: "a".repeat(40),
        files: [
          {
            path: "README.md",
            old_path: null,
            change: "modified",
            binary: false,
            old: { type: "inline", text: "a" },
            new: { type: "inline", text: "b" },
          },
          {
            path: "logo.png",
            old_path: null,
            change: "added",
            binary: true,
            old: null,
            new: null,
          },
        ],
      }),
    );
    expect(timeline.items).toEqual([
      {
        key: "run_diff-1",
        seq: 1,
        ts: at(0),
        lastTs: at(0),
        type: "run_diff",
        fileCount: 2,
        paths: ["README.md", "logo.png"],
      },
    ]);
  });

  it("usage 取最新一筆、不出現在時間軸；status_changed 更新目前狀態", () => {
    const usage = {
      input_tokens: 1,
      output_tokens: 2,
      thought_tokens: null,
      cached_read_tokens: null,
      cached_write_tokens: null,
      context_used_tokens: 10,
      context_window_tokens: 100,
      cost: null,
    };
    const timeline = replay(
      events(
        { kind: "usage", ...usage },
        { kind: "usage", ...usage, output_tokens: 5 },
        { kind: "status_changed", status: "awaiting_gate", gate: "review", message: null },
      ),
    );
    expect(timeline.usage).toEqual({ ...usage, output_tokens: 5 });
    expect(timeline.status).toBe("awaiting_gate");
    expect(timeline.gate).toBe("review");
    expect(timeline.items.map((item) => item.type)).toEqual(["status"]);
  });

  it("不認得的錯誤代碼當成 internal", () => {
    const timeline = replay(
      events({ kind: "error", code: "brand_new" as never, message: "壞了", fatal: true }),
    );
    expect(timeline.items[0]).toMatchObject({ type: "error", code: "internal", fatal: true });
  });

  it("不認得的 Event kind 只推進 seq", () => {
    const timeline = replay(events({ kind: "future_kind" } as never, text("之後")));
    expect(timeline.lastSeq).toBe(2);
    expect(timeline.items.map((item) => item.type)).toEqual(["message"]);
  });
});

describe("applyEvents：seq", () => {
  const list = events(text("a"), text("b"), { kind: "thought_chunk", text: "c" }, text("d"));

  it("重複的 Event 被忽略，而且沒有變化時回傳同一個物件", () => {
    const once = replay(list);
    expect(applyEvents(once, list)).toBe(once);
    expect(rendered(applyEvents(EMPTY_TIMELINE, [...list, ...list]))).toEqual(rendered(once));
  });

  it("亂序的 Event 先暫存，補齊後依序套用", () => {
    const [first, second, third, fourth] = list as [RunEvent, RunEvent, RunEvent, RunEvent];
    const partial = applyEvents(EMPTY_TIMELINE, [first, third, fourth]);
    expect(partial.lastSeq).toBe(1);
    expect(missingSeq(partial)).toBe(2);
    const complete = applyEvents(partial, [second]);
    expect(missingSeq(complete)).toBeNull();
    expect(rendered(complete)).toEqual(rendered(replay(list)));
  });

  it("不修改傳入的時間軸", () => {
    const before = replay(list.slice(0, 2));
    const snapshot = structuredClone(rendered(before));
    applyEvents(before, list.slice(2));
    expect(rendered(before)).toEqual(snapshot);
  });
});

describe("applyEvents：即時套用與重播結果相同", () => {
  const fixtures = {
    "M1 第一回合（權限請求 + diff）": m1FirstTurnEvents("run-1"),
    "5,000 筆 Event": generateLargeRun("run-1", 5_000),
  };

  for (const [name, list] of Object.entries(fixtures)) {
    it(`${name}：逐筆、分批、亂序都與一次重播相同`, () => {
      const replayed = rendered(replay(list));

      let oneByOne = EMPTY_TIMELINE;
      for (const event of list) oneByOne = applyEvents(oneByOne, [event]);
      expect(rendered(oneByOne)).toEqual(replayed);

      let batched = EMPTY_TIMELINE;
      for (let start = 0; start < list.length; start += 7) {
        batched = applyEvents(batched, list.slice(start, start + 7));
      }
      expect(rendered(batched)).toEqual(replayed);

      // 每 10 筆一組反轉順序，再重送一次前半段，模擬斷線重連
      const shuffled: RunEvent[] = [];
      for (let start = 0; start < list.length; start += 10) {
        shuffled.push(...list.slice(start, start + 10).reverse());
      }
      shuffled.push(...list.slice(0, list.length / 2));
      expect(rendered(applyEvents(EMPTY_TIMELINE, shuffled))).toEqual(replayed);
    });
  }
});

describe("applyEvents：協定 v2 的 Event", () => {
  it("plan、Verification、合併 Child Run、prompt 與 Preview 停止各成一個項目；agent_session 不顯示", () => {
    const timeline = replay(
      events(
        { kind: "agent_session", session_id: "s-1" },
        {
          kind: "prompt_submitted",
          prompt: [{ type: "text", text: "請修正測試" }],
          source: "verification_retry",
        },
        {
          kind: "plan_proposed",
          body: { type: "inline", text: "1. 改 README" },
          source: "plan_mode",
        },
        {
          kind: "verification_result",
          verification_id: "v-1",
          attempt: 1,
          criterion_id: "ac-1",
          outcome: "failed",
          summary: "exit code 1",
          evidence: [],
          judged_by_run_id: null,
        },
        { kind: "verification_completed", verification_id: "v-1", attempt: 1, outcome: "failed" },
        {
          kind: "child_merged",
          child_run_id: "run-2",
          outcome: "conflict",
          commit_sha: null,
          conflicted_paths: ["a.ts"],
        },
        { kind: "preview_stopped", reason: "exited", exit_code: 1, output: "boom" },
      ),
    );
    expect(timeline.lastSeq).toBe(7);
    expect(timeline.items.map((item) => item.type)).toEqual([
      "prompt",
      "plan_proposed",
      "verification_result",
      "verification_completed",
      "child_merged",
      "preview_stopped",
    ]);
    expect(timeline.items[0]).toMatchObject({ source: "verification_retry" });
    expect(timeline.items[2]).toMatchObject({ criterionId: "ac-1", outcome: "failed", attempt: 1 });
    expect(timeline.items[4]).toMatchObject({ conflictedPaths: ["a.ts"], commitSha: null });
  });
});
