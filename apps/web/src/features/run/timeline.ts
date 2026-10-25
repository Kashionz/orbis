// 把 Run 的 Event 依 seq 套用成畫面要顯示的時間軸（純函式）。
//
// 同一串 Event 不論是即時逐筆收到、分批收到、重複或亂序收到，還是重新整理後一次重播，
// 套用的結果都相同；Run 即時檢視「重新整理後畫面完全一樣」靠的就是這一點。

import type { RunEvent } from "@orbis/api-contract";
import {
  type ContentBlock,
  type GateKind,
  type MergeOutcome,
  type PermissionOption,
  type PermissionPurpose,
  type PlanEntry,
  type PlanSource,
  type PreviewStopReason,
  type PromptSource,
  RUN_ERROR_CODES,
  type RunErrorCode,
  type RunStatus,
  type TextBody,
  type ToolCallContent,
  type ToolCallLocation,
  type ToolCallStatus,
  type ToolKind,
  type Usage,
  type VerificationOutcome,
} from "@orbis/protocol";

interface ItemBase {
  /** React key：這個項目第一筆 Event 的 seq（tool call 與權限請求用各自的 id）。 */
  key: string;
  /** 這個項目第一筆 Event 的 seq。 */
  seq: number;
  /** 這個項目第一筆 Event 的時間。 */
  ts: string;
  /** 最後一筆更新這個項目的 Event 的時間（合併的片段、tool call 的更新、權限回覆）。 */
  lastTs: string;
}

export type TimelineItem =
  | (ItemBase & { type: "message"; blocks: ContentBlock[] })
  | (ItemBase & { type: "thought"; text: string })
  | (ItemBase & {
      type: "tool_call";
      toolCallId: string;
      title: string;
      toolKind: ToolKind;
      status: ToolCallStatus;
      content: ToolCallContent[];
      locations: ToolCallLocation[];
    })
  | (ItemBase & {
      type: "permission";
      requestId: string;
      toolCallId: string | null;
      title: string;
      /** 用途：一般 tool call、設定的信任核准、Agent 設定檔被修改。 */
      purpose: PermissionPurpose;
      options: PermissionOption[];
      /** 尚未回覆時為 null；`selectedOptionId` 為 null 表示請求被取消。 */
      resolved: { selectedOptionId: string | null } | null;
    })
  | (ItemBase & { type: "plan"; entries: PlanEntry[] })
  | (ItemBase & {
      type: "status";
      status: RunStatus;
      gate: GateKind | null;
      message: string | null;
    })
  | (ItemBase & { type: "error"; code: RunErrorCode; message: string; fatal: boolean })
  | (ItemBase & { type: "rate_limited"; resetsAt: string | null; message: string })
  | (ItemBase & { type: "preview_ready"; port: number; url: string })
  | (ItemBase & {
      type: "worktree_ready";
      worktreePath: string;
      branch: string | null;
      baseCommit: string;
    })
  | (ItemBase & {
      type: "run_diff";
      /** 有變更的檔案數。完整內容由 review diff 端點取得，不放進時間軸。 */
      fileCount: number;
      /** 有變更的檔案路徑（訊息中的檔名連到差異分頁用）。 */
      paths: string[];
    })
  /** Agent 提出 plan，等待 Plan Gate（全文在 Run 頁的 plan 面板）。 */
  | (ItemBase & { type: "plan_proposed"; body: TextBody; source: PlanSource })
  | (ItemBase & {
      type: "verification_result";
      attempt: number;
      criterionId: string;
      outcome: VerificationOutcome;
      summary: string;
    })
  | (ItemBase & { type: "verification_completed"; attempt: number; outcome: VerificationOutcome })
  | (ItemBase & {
      type: "child_merged";
      childRunId: string;
      outcome: MergeOutcome;
      commitSha: string | null;
      conflictedPaths: string[];
    })
  /** 送給 Agent 的 prompt（派工、Gate 退回、Verification 重試、Feedback Loop 等）。 */
  | (ItemBase & { type: "prompt"; source: PromptSource; blocks: ContentBlock[] })
  | (ItemBase & {
      type: "preview_stopped";
      reason: PreviewStopReason;
      exitCode: number | null;
      output: string;
    });

export interface Timeline {
  items: readonly TimelineItem[];
  /** 最近一筆 `usage` Event；還沒有時為 null。 */
  usage: Usage | null;
  /** 最近一筆 `status_changed` 的狀態；還沒有時為 null。 */
  status: RunStatus | null;
  /** 等待中的 Gate（`awaiting_gate` 時）。 */
  gate: GateKind | null;
  /** 已連續套用的最大 seq；還沒有任何 Event 時為 0。 */
  lastSeq: number;
  /** 收到但還不連續、先暫存的 Event。 */
  pending: ReadonlyMap<number, RunEvent>;
  toolCallIndex: ReadonlyMap<string, number>;
  permissionIndex: ReadonlyMap<string, number>;
}

export const EMPTY_TIMELINE: Timeline = {
  items: [],
  usage: null,
  status: null,
  gate: null,
  lastSeq: 0,
  pending: new Map(),
  toolCallIndex: new Map(),
  permissionIndex: new Map(),
};

/** 套用過程中可以直接修改的副本，套用完才包成新的 Timeline。 */
interface Draft {
  items: TimelineItem[];
  usage: Usage | null;
  status: RunStatus | null;
  gate: GateKind | null;
  lastSeq: number;
  pending: Map<number, RunEvent>;
  toolCallIndex: Map<string, number>;
  permissionIndex: Map<string, number>;
}

/** 協定允許之後增加錯誤代碼；不認得的值當成 `internal`。 */
function normalizeErrorCode(code: string): RunErrorCode {
  return (RUN_ERROR_CODES as readonly string[]).includes(code)
    ? (code as RunErrorCode)
    : "internal";
}

function appendBlock(blocks: ContentBlock[], block: ContentBlock): ContentBlock[] {
  const last = blocks.at(-1);
  if (last?.type === "text" && block.type === "text") {
    return [...blocks.slice(0, -1), { type: "text", text: last.text + block.text }];
  }
  return [...blocks, block];
}

function applyOne(draft: Draft, { seq, ts, event }: RunEvent): void {
  const last = draft.items.at(-1);
  const lastIndex = draft.items.length - 1;
  const base = { key: `${event.kind}-${seq}`, seq, ts, lastTs: ts };

  switch (event.kind) {
    case "message_chunk":
      // 連續的訊息片段合併成一則訊息
      if (last?.type === "message") {
        draft.items[lastIndex] = {
          ...last,
          blocks: appendBlock(last.blocks, event.content),
          lastTs: ts,
        };
      } else {
        draft.items.push({ ...base, type: "message", blocks: [event.content] });
      }
      return;

    case "thought_chunk":
      if (last?.type === "thought") {
        draft.items[lastIndex] = { ...last, text: last.text + event.text, lastTs: ts };
      } else {
        draft.items.push({ ...base, type: "thought", text: event.text });
      }
      return;

    case "tool_call": {
      // 同一個 tool_call_id 的後續 Event 是更新：null 沿用前值，有值整個取代
      const index = draft.toolCallIndex.get(event.tool_call_id);
      const existing = index === undefined ? undefined : draft.items[index];
      if (index !== undefined && existing?.type === "tool_call") {
        draft.items[index] = {
          ...existing,
          title: event.title ?? existing.title,
          toolKind: event.tool_kind ?? existing.toolKind,
          status: event.status ?? existing.status,
          content: event.content ?? existing.content,
          locations: event.locations ?? existing.locations,
          lastTs: ts,
        };
        return;
      }
      draft.toolCallIndex.set(event.tool_call_id, draft.items.length);
      draft.items.push({
        key: `tool_call-${event.tool_call_id}`,
        seq,
        ts,
        lastTs: ts,
        type: "tool_call",
        toolCallId: event.tool_call_id,
        title: event.title ?? event.tool_call_id,
        toolKind: event.tool_kind ?? "other",
        status: event.status ?? "pending",
        content: event.content ?? [],
        locations: event.locations ?? [],
      });
      return;
    }

    case "permission_request":
      if (draft.permissionIndex.has(event.request_id)) return;
      draft.permissionIndex.set(event.request_id, draft.items.length);
      draft.items.push({
        key: `permission-${event.request_id}`,
        seq,
        ts,
        lastTs: ts,
        type: "permission",
        requestId: event.request_id,
        toolCallId: event.tool_call_id,
        title: event.title,
        // 協定加入 purpose 之前保存的 Event 沒有這個欄位，視為一般的 tool call
        purpose: event.purpose ?? "tool",
        options: event.options,
        resolved: null,
      });
      return;

    case "permission_resolved": {
      const index = draft.permissionIndex.get(event.request_id);
      const existing = index === undefined ? undefined : draft.items[index];
      if (index === undefined || existing?.type !== "permission") return;
      draft.items[index] = {
        ...existing,
        resolved: { selectedOptionId: event.selected_option_id },
        lastTs: ts,
      };
      return;
    }

    case "plan":
      draft.items.push({ ...base, type: "plan", entries: event.entries });
      return;

    case "usage": {
      const { kind: _kind, ...usage } = event;
      draft.usage = usage;
      return;
    }

    case "status_changed":
      draft.status = event.status;
      draft.gate = event.gate;
      draft.items.push({
        ...base,
        type: "status",
        status: event.status,
        gate: event.gate,
        message: event.message,
      });
      return;

    case "error":
      draft.items.push({
        ...base,
        type: "error",
        code: normalizeErrorCode(event.code),
        message: event.message,
        fatal: event.fatal,
      });
      return;

    case "rate_limited":
      draft.items.push({
        ...base,
        type: "rate_limited",
        resetsAt: event.resets_at,
        message: event.message,
      });
      return;

    case "preview_ready":
      draft.items.push({ ...base, type: "preview_ready", port: event.port, url: event.url });
      return;

    case "worktree_ready":
      draft.items.push({
        ...base,
        type: "worktree_ready",
        worktreePath: event.worktree_path,
        branch: event.branch,
        baseCommit: event.base_commit,
      });
      return;

    case "run_diff":
      draft.items.push({
        ...base,
        type: "run_diff",
        fileCount: event.files.length,
        paths: event.files.map((file) => file.path),
      });
      return;

    case "plan_proposed":
      draft.items.push({ ...base, type: "plan_proposed", body: event.body, source: event.source });
      return;

    case "verification_result":
      draft.items.push({
        ...base,
        type: "verification_result",
        attempt: event.attempt,
        criterionId: event.criterion_id,
        outcome: event.outcome,
        summary: event.summary,
      });
      return;

    case "verification_completed":
      draft.items.push({
        ...base,
        type: "verification_completed",
        attempt: event.attempt,
        outcome: event.outcome,
      });
      return;

    case "child_merged":
      draft.items.push({
        ...base,
        type: "child_merged",
        childRunId: event.child_run_id,
        outcome: event.outcome,
        commitSha: event.commit_sha,
        conflictedPaths: event.conflicted_paths,
      });
      return;

    case "prompt_submitted":
      draft.items.push({ ...base, type: "prompt", source: event.source, blocks: event.prompt });
      return;

    case "preview_stopped":
      draft.items.push({
        ...base,
        type: "preview_stopped",
        reason: event.reason,
        exitCode: event.exit_code,
        output: event.output,
      });
      return;

    default:
      // 協定之後新增的 Event kind：只推進 seq，不顯示
      return;
  }
}

/**
 * 把一批 Event 套用到時間軸上，回傳新的時間軸（不修改傳入的物件）。
 * 已套用過的 seq 會被忽略；不連續的 Event 先暫存，等前面的補齊後再依序套用。
 * 沒有任何變化時回傳原本的物件。
 */
export function applyEvents(timeline: Timeline, events: readonly RunEvent[]): Timeline {
  let draft: Draft | null = null;
  for (const event of events) {
    const current: Timeline | Draft = draft ?? timeline;
    if (event.seq <= current.lastSeq || current.pending.has(event.seq)) continue;
    draft ??= {
      items: [...timeline.items],
      usage: timeline.usage,
      status: timeline.status,
      gate: timeline.gate,
      lastSeq: timeline.lastSeq,
      pending: new Map(timeline.pending),
      toolCallIndex: new Map(timeline.toolCallIndex),
      permissionIndex: new Map(timeline.permissionIndex),
    };
    draft.pending.set(event.seq, event);
    for (let next = draft.pending.get(draft.lastSeq + 1); next; ) {
      draft.pending.delete(next.seq);
      applyOne(draft, next);
      draft.lastSeq = next.seq;
      next = draft.pending.get(draft.lastSeq + 1);
    }
  }
  return draft ?? timeline;
}

/** 時間軸缺少的第一個 seq；沒有缺號時為 null。 */
export function missingSeq(timeline: Timeline): number | null {
  return timeline.pending.size > 0 ? timeline.lastSeq + 1 : null;
}
