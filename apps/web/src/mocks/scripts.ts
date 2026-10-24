// MSW 假後端用的 Run 劇本：照 crates/fake-agent/scripts 的 permission.yaml 與 diff.yaml 轉寫成
// 協定的 Event，讓開發與元件層級的測試看到和真實系統相同形狀的資料。
// 也提供時間軸單元測試與效能測試用的 Event 產生器。

import { NAMES, type RunEvent } from "@orbis/api-contract";
import type { EventKind, ToolCallContent } from "@orbis/protocol";

export type ScriptStep =
  | { type: "event"; event: EventKind }
  /** 送出權限請求後暫停，依回覆的選項走不同分支。 */
  | {
      type: "await_permission";
      request: Extract<EventKind, { kind: "permission_request" }>;
      allow: ScriptStep[];
      reject: ScriptStep[];
    };

/** Worktree 在 base commit 時的檔案內容。 */
export const BASE_FILES: Readonly<Record<string, string>> = {
  "README.md": "# Demo\n",
  "src/main.ts": 'export function main() {\n  console.log("hello");\n}\n',
};

export const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const event = (value: EventKind): ScriptStep => ({ type: "event", event: value });
const say = (text: string): ScriptStep =>
  event({ kind: "message_chunk", content: { type: "text", text } });
const think = (text: string): ScriptStep => event({ kind: "thought_chunk", text });

function diff(path: string, oldText: string | null, newText: string | null): ToolCallContent {
  return {
    type: "diff",
    path,
    old: oldText === null ? null : { type: "inline", text: oldText },
    new: newText === null ? null : { type: "inline", text: newText },
  };
}

function editCall(id: string, title: string, content: ToolCallContent): ScriptStep[] {
  const path = content.type === "diff" ? content.path : null;
  return [
    event({
      kind: "tool_call",
      tool_call_id: id,
      title,
      tool_kind: "edit",
      status: "in_progress",
      content: [content],
      locations: path ? [{ path, line: 1 }] : [],
    }),
    event({
      kind: "tool_call",
      tool_call_id: id,
      title: null,
      tool_kind: null,
      status: "completed",
      content: null,
      locations: null,
    }),
  ];
}

function usage(contextUsed: number, amount: number): ScriptStep {
  return event({
    kind: "usage",
    input_tokens: contextUsed * 4,
    output_tokens: Math.round(contextUsed / 3),
    thought_tokens: null,
    cached_read_tokens: null,
    cached_write_tokens: null,
    context_used_tokens: contextUsed,
    context_window_tokens: 200_000,
    cost: { amount, currency: "USD" },
  });
}

export const README_V1 = "# Demo\n\n已由 Fake Agent 更新。\n";
export const README_V2 = "# Demo\n\n已由 Fake Agent 更新，並依照 review 留言補上說明。\n";
export const CONFIG_JSON = '{ "enabled": true }\n';
export const HELLO_TXT = "hello from fake agent\n";

/** M1 第一回合：permission.yaml（寫 config.json 前先問）接著 diff.yaml（新增與修改檔案）。 */
export function m1FirstTurn(branch: string): ScriptStep[] {
  return [
    event({
      kind: "worktree_ready",
      worktree_path: "C:/wt/demo/run",
      branch,
      base_commit: BASE_COMMIT,
    }),
    event({ kind: "status_changed", status: "running", gate: null, message: null }),
    think("先看看專案裡有什麼。"),
    say("我需要寫入 config.json。"),
    event({
      kind: "tool_call",
      tool_call_id: "write-config",
      title: "寫入 config.json",
      tool_kind: "edit",
      status: "pending",
      content: [diff("config.json", null, CONFIG_JSON)],
      locations: [{ path: "config.json", line: null }],
    }),
    {
      type: "await_permission",
      request: {
        kind: "permission_request",
        purpose: "tool",
        request_id: "perm-write-config",
        tool_call_id: "write-config",
        title: "寫入 config.json",
        options: [
          { option_id: "allow", name: "允許", kind: "allow_once" },
          { option_id: "reject", name: "拒絕", kind: "reject_once" },
        ],
      },
      allow: [
        event({
          kind: "tool_call",
          tool_call_id: "write-config",
          title: null,
          tool_kind: null,
          status: "completed",
          content: null,
          locations: null,
        }),
        say("已寫入 config.json。"),
      ],
      reject: [
        event({
          kind: "tool_call",
          tool_call_id: "write-config",
          title: null,
          tool_kind: null,
          status: "failed",
          content: null,
          locations: null,
        }),
        say("好，我不會修改 config.json。"),
      ],
    },
    say("我來新增 hello.txt，並更新 README.md。"),
    event({
      kind: "tool_call",
      tool_call_id: "read-readme",
      title: "讀取 README.md",
      tool_kind: "read",
      status: "completed",
      content: [{ type: "text", text: BASE_FILES["README.md"] ?? "" }],
      locations: [{ path: "README.md", line: null }],
    }),
    ...editCall("write-hello", "新增 hello.txt", diff("hello.txt", null, HELLO_TXT)),
    ...editCall(
      "edit-readme",
      "編輯 README.md",
      diff("README.md", BASE_FILES["README.md"] ?? "", README_V1),
    ),
    event({
      kind: "tool_call",
      tool_call_id: "run-tests",
      title: "pnpm test",
      tool_kind: "execute",
      status: "completed",
      content: [
        {
          type: "terminal",
          terminal_id: "term-1",
          command: "pnpm test",
          output: { type: "inline", text: "✓ 3 個測試通過\n" },
          exit_code: 0,
        },
      ],
      locations: [],
    }),
    usage(1200, 0.0125),
    say("完成了。"),
    event({ kind: "status_changed", status: "awaiting_gate", gate: "review", message: null }),
  ];
}

/** 實機中 Codex 把模型錯誤當成一般回覆、以 end_turn 結束回合時的回覆（#73）。 */
export const MODEL_ERROR_REPLY =
  "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.";

/** 沒有修改任何檔案就結束回合（Agent 把模型錯誤當成回覆，#73）：review diff 為空。 */
export function emptyDiffTurn(branch: string): ScriptStep[] {
  return [
    event({
      kind: "worktree_ready",
      worktree_path: "C:/wt/demo/empty",
      branch,
      base_commit: BASE_COMMIT,
    }),
    event({ kind: "status_changed", status: "running", gate: null, message: null }),
    say(MODEL_ERROR_REPLY),
    event({ kind: "status_changed", status: "awaiting_gate", gate: "review", message: null }),
  ];
}

/** Review Gate 退回後的第二回合：依留言修改 README.md。 */
export function m1RevisionTurn(): ScriptStep[] {
  return [
    event({ kind: "status_changed", status: "running", gate: null, message: "Review 退回" }),
    say("收到 review 留言，我來修改 README.md。"),
    ...editCall("edit-readme-2", "編輯 README.md", diff("README.md", README_V1, README_V2)),
    usage(2400, 0.025),
    say("已依照留言修改。"),
    event({ kind: "status_changed", status: "awaiting_gate", gate: "review", message: null }),
  ];
}

export const PLAN_V1 = "## Plan\n\n1. 新增 `hello.txt`\n2. 在 README.md 說明用途\n";
export const PLAN_V2 =
  "## Plan（修訂）\n\n1. 新增 `hello.txt`\n2. 在 README.md 說明用途\n3. 補上測試\n";

/** 開啟 Plan Gate 時的 Planning 回合：Agent 以 plan 模式提出 plan，等待 Plan Gate。 */
export function planTurn(branch: string): ScriptStep[] {
  return [
    event({
      kind: "worktree_ready",
      worktree_path: "C:/wt/demo/run",
      branch,
      base_commit: BASE_COMMIT,
    }),
    event({ kind: "status_changed", status: "running", gate: null, message: null }),
    say("我先擬定 plan。"),
    event({ kind: "plan_proposed", body: { type: "inline", text: PLAN_V1 }, source: "plan_mode" }),
    event({ kind: "status_changed", status: "awaiting_gate", gate: "plan", message: null }),
  ];
}

/** Plan Gate 退回後依意見修訂 plan。 */
export function planRevisionTurn(): ScriptStep[] {
  return [
    event({ kind: "status_changed", status: "running", gate: null, message: "Plan Gate 退回" }),
    say("收到意見，我修訂 plan。"),
    event({ kind: "plan_proposed", body: { type: "inline", text: PLAN_V2 }, source: "plan_mode" }),
    event({ kind: "status_changed", status: "awaiting_gate", gate: "plan", message: null }),
  ];
}

/** plan 核准後的實作回合：同 M1 第一回合，但 Worktree 已經建好。 */
export function implementTurn(branch: string): ScriptStep[] {
  return m1FirstTurn(branch).slice(1);
}

/** Verification 失敗後，Server 把失敗原因送回 Agent 的修正回合。 */
export function verificationFixTurn(): ScriptStep[] {
  return [
    event({
      kind: "status_changed",
      status: "running",
      gate: null,
      message: "Verification 失敗，重試",
    }),
    say("依 Verification 的失敗原因修正。"),
    usage(1800, 0.02),
    say("已修正。"),
    event({ kind: "status_changed", status: "awaiting_gate", gate: "review", message: null }),
  ];
}

/** Repo 設定檔相對於 repo 根目錄的路徑（ARCHITECTURE §6.3）。 */
export const CONFIG_PATH = `${NAMES.configDir}/${NAMES.configFile}`;

/** 設定的信任核准（ARCHITECTURE §6.2）：Repo 設定檔的 setup 腳本第一次執行前要 Admin 以上核准。 */
export function configTrustTurn(branch: string): ScriptStep[] {
  return [
    event({
      kind: "worktree_ready",
      worktree_path: "C:/wt/demo/trust",
      branch,
      base_commit: BASE_COMMIT,
    }),
    {
      type: "await_permission",
      request: {
        kind: "permission_request",
        purpose: "config_trust",
        request_id: "perm-config-trust",
        tool_call_id: null,
        title: `執行 ${CONFIG_PATH} 的 setup：pnpm install`,
        options: [
          { option_id: "trust", name: "信任並執行", kind: "allow_once" },
          { option_id: "skip", name: "不執行", kind: "reject_once" },
        ],
      },
      allow: [
        event({ kind: "status_changed", status: "running", gate: null, message: null }),
        say("setup 已完成。"),
      ],
      reject: [say("沒有執行 setup。")],
    },
  ];
}

const BASE_TIME = Date.UTC(2026, 9, 23, 8, 0, 0);

export function toRunEvents(runId: string, kinds: readonly EventKind[], firstSeq = 1): RunEvent[] {
  return kinds.map((value, index) => ({
    runId,
    seq: firstSeq + index,
    ts: new Date(BASE_TIME + (firstSeq + index) * 1000).toISOString(),
    event: value,
  }));
}

/** 把劇本展開成 Event（權限請求一律走 `choice` 分支，並補上 permission_resolved）。 */
export function flattenScript(
  steps: readonly ScriptStep[],
  choice: "allow" | "reject",
): EventKind[] {
  return steps.flatMap((step): EventKind[] => {
    if (step.type === "event") return [step.event];
    const optionId = step.request.options.find((option) =>
      option.kind.startsWith(choice === "allow" ? "allow" : "reject"),
    )?.option_id;
    return [
      step.request,
      {
        kind: "permission_resolved",
        request_id: step.request.request_id,
        selected_option_id: optionId ?? null,
      },
      ...flattenScript(step[choice], choice),
    ];
  });
}

/** M1 第一回合（允許權限請求）的完整 Event。 */
export function m1FirstTurnEvents(runId: string): RunEvent[] {
  return toRunEvents(runId, flattenScript(m1FirstTurn("feature/run"), "allow"));
}

export const LARGE_RUN_LAST_MESSAGE = "這是最後一筆 Event。";

/**
 * 產生 `count` 筆混合各種 kind 的 Event，用於虛擬列表的效能測試。
 * 內容是確定的（同樣的參數產生同樣的 Event）。
 */
export function generateLargeRun(runId: string, count: number): RunEvent[] {
  const kinds: EventKind[] = [
    {
      kind: "worktree_ready",
      worktree_path: "C:/wt/demo/large",
      branch: "feature/large",
      base_commit: BASE_COMMIT,
    },
    { kind: "status_changed", status: "running", gate: null, message: null },
  ];
  for (let round = 0; kinds.length < count; round += 1) {
    kinds.push(
      { kind: "thought_chunk", text: `第 ${round} 輪：檢查下一個檔案。` },
      { kind: "message_chunk", content: { type: "text", text: `第 ${round} 輪訊息，` } },
      { kind: "message_chunk", content: { type: "text", text: `處理 src/file-${round}.ts。` } },
      {
        kind: "tool_call",
        tool_call_id: `call-${round}`,
        title: `編輯 src/file-${round}.ts`,
        tool_kind: round % 3 === 0 ? "execute" : "edit",
        status: "in_progress",
        content:
          round % 3 === 0
            ? [
                {
                  type: "terminal",
                  terminal_id: `term-${round}`,
                  command: "pnpm test",
                  output: { type: "inline", text: `round ${round}\n`.repeat((round % 5) + 1) },
                  exit_code: 0,
                },
              ]
            : [
                diff(
                  `src/file-${round}.ts`,
                  `export const value = ${round};\n`,
                  `export const value = ${round + 1};\n`,
                ),
              ],
        locations: [{ path: `src/file-${round}.ts`, line: 1 }],
      },
      {
        kind: "tool_call",
        tool_call_id: `call-${round}`,
        title: null,
        tool_kind: null,
        status: "completed",
        content: null,
        locations: null,
      },
    );
    if (round % 10 === 0) {
      kinds.push({
        kind: "usage",
        input_tokens: round * 100,
        output_tokens: round * 10,
        thought_tokens: null,
        cached_read_tokens: null,
        cached_write_tokens: null,
        context_used_tokens: round * 50,
        context_window_tokens: 200_000,
        cost: { amount: round / 1000, currency: "USD" },
      });
    }
    if (round % 25 === 0) {
      kinds.push(
        {
          kind: "permission_request",
          purpose: "tool",
          request_id: `perm-${round}`,
          tool_call_id: `call-${round}`,
          title: `執行 pnpm install（第 ${round} 輪）`,
          options: [
            { option_id: "allow", name: "允許", kind: "allow_once" },
            { option_id: "reject", name: "拒絕", kind: "reject_once" },
          ],
        },
        { kind: "permission_resolved", request_id: `perm-${round}`, selected_option_id: "allow" },
      );
    }
  }
  // 最後一筆固定是可辨識的訊息，測試用來確認捲到底時看得到
  kinds.length = count - 1;
  kinds.push({ kind: "message_chunk", content: { type: "text", text: LARGE_RUN_LAST_MESSAGE } });
  return toRunEvents(runId, kinds);
}
