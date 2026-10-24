// 把時間軸（timeline.ts）整理成事件串流要顯示的項目（純函式）。
//
// - 連續的 tool call 合成一個工具群組，預設收合成一行摘要。
// - 連續的 Verification 結果合成一個驗收群組，有失敗時預設展開。
// - Agent 與人輪流發言時，在每一段的第一個項目上方放頭像列。
// - 等待權限回覆、權限回覆後的繼續執行等狀態不另外顯示一列（權限請求本身已經看得到）。
// - 尾列（複製最後的回覆、時間、工作了多久）只在整個執行結束後顯示。

import type { GateKind, RunStatus, ToolKind, VerificationOutcome } from "@orbis/protocol";
import { TERMINAL_RUN_STATUSES } from "@orbis/protocol";
import type { TimelineItem } from "../timeline";

type ItemOf<T extends TimelineItem["type"]> = Extract<TimelineItem, { type: T }>;

export type ToolCallItem = ItemOf<"tool_call">;
export type VerificationResultItem = ItemOf<"verification_result">;

/** 項目上方的頭像列：Agent（logo＋代號＋模型）或送出 prompt 的人。 */
export type StreamHead = { actor: "agent" } | { actor: "user"; source: ItemOf<"prompt">["source"] };

/** 工具群組的分類：摘要依分類計數。 */
export type ToolBucket = "read" | "search" | "edit" | "execute" | "other";

/** 工具群組收合時的標題。 */
export type ToolGroupLabel = "working" | "edited" | "executed" | "viewed";

interface Base {
  key: string;
  /** 頭像列；這個項目延續上一段時為 null。 */
  head: StreamHead | null;
}

export type StreamItem =
  | (Base & { kind: "prompt"; item: ItemOf<"prompt"> })
  | (Base & { kind: "message"; item: ItemOf<"message"> })
  | (Base & {
      kind: "thought";
      item: ItemOf<"thought">;
      /** 正在思考：這是最後一個項目，而且 Run 正在執行。 */
      live: boolean;
      /** 思考了幾秒；只有一筆片段而且後面沒有其他項目時為 null。 */
      seconds: number | null;
    })
  | (Base & {
      kind: "tool_group";
      tools: ToolCallItem[];
      running: boolean;
      failed: number;
      counts: Record<ToolBucket, number>;
      label: ToolGroupLabel;
      durationSeconds: number;
      /** 沒有手動展開或收合時是否展開。 */
      defaultOpen: boolean;
    })
  | (Base & {
      kind: "plan";
      item: ItemOf<"plan">;
      done: number;
      total: number;
      /** 進行中的步驟，沒有時是第一個還沒開始的步驟。 */
      current: string | null;
    })
  | (Base & { kind: "plan_proposed"; item: ItemOf<"plan_proposed"> })
  | (Base & {
      kind: "verification_group";
      results: VerificationResultItem[];
      /** 接在後面的 `verification_completed` 的結果；還沒結束時為 null。 */
      completed: VerificationOutcome | null;
      passed: number;
      failed: number;
      defaultOpen: boolean;
    })
  | (Base & {
      kind: "permission";
      item: ItemOf<"permission">;
      /** 展開標題時顯示的細節（觸發請求的指令或檔案路徑）；沒有時為 null。 */
      detail: string | null;
    })
  | (Base & { kind: "status"; item: ItemOf<"status"> })
  | (Base & { kind: "error"; item: ItemOf<"error"> })
  | (Base & { kind: "rate_limited"; item: ItemOf<"rate_limited"> })
  | (Base & {
      kind: "system";
      item:
        | ItemOf<"worktree_ready">
        | ItemOf<"preview_ready">
        | ItemOf<"preview_stopped">
        | ItemOf<"run_diff">
        | ItemOf<"child_merged">
        | ItemOf<"verification_completed">;
    });

export interface StreamContext {
  /** Run 目前的狀態；還不知道時為 null。 */
  status: RunStatus | null;
  /** `awaiting_gate` 時等待的 Gate。 */
  gate: GateKind | null;
  /** 設定的「自動展開工具步驟」：進行中與最後的工具群組預設展開。 */
  autoExpandTools: boolean;
}

/** 尾列：整個執行結束後，最後一則 Agent 回覆底下的一列。 */
export interface StreamTail {
  /** 最後一則回覆的項目 key。 */
  messageKey: string;
  /** 最後一則回覆的文字（複製用）。 */
  text: string;
  /** 回覆最後更新的時間。 */
  ts: string;
  /** 從送出 prompt 到最後一則回覆，工作了幾秒。 */
  turnSeconds: number;
}

const LIVE_STATUSES: readonly RunStatus[] = ["starting", "running", "verifying"];

/** Run 正在執行（Agent 或 Verification 在動）。 */
export function isLive(status: RunStatus | null): boolean {
  return status !== null && LIVE_STATUSES.includes(status);
}

/**
 * 整個執行已經結束：不在執行中、沒有等待回覆的權限請求、不在計畫關卡。
 * 審查關卡算結束（Agent 的回合已經結束，等人決定）。
 */
export function isTurnFinished(
  status: RunStatus | null,
  gate: GateKind | null,
  items: readonly TimelineItem[],
): boolean {
  if (status === null) return false;
  if (items.some((item) => item.type === "permission" && item.resolved === null)) return false;
  if (status === "awaiting_gate") return gate === "review";
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export function toolBucket(kind: ToolKind): ToolBucket {
  switch (kind) {
    case "read":
    case "search":
    case "execute":
      return kind;
    case "edit":
    case "delete":
    case "move":
      return "edit";
    default:
      return "other";
  }
}

function seconds(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
}

const AGENT_KINDS: ReadonlySet<StreamItem["kind"]> = new Set([
  "message",
  "thought",
  "tool_group",
  "plan",
  "plan_proposed",
  "permission",
]);

/** 不另外顯示一列的狀態：等待權限回覆（看權限請求）、速率限制（看 rate_limited 那一列）。 */
const HIDDEN_STATUSES: readonly RunStatus[] = ["awaiting_permission", "rate_limited"];

/** 這一列狀態是否顯示。`previous`／`next` 是前後最近的狀態列。 */
function showStatus(
  item: ItemOf<"status">,
  previous: ItemOf<"status"> | undefined,
  next: ItemOf<"status"> | undefined,
): boolean {
  if (HIDDEN_STATUSES.includes(item.status)) return false;
  // 權限回覆或速率限制解除後回到執行中，不是新的開始
  if (item.status === "running" && previous && HIDDEN_STATUSES.includes(previous.status)) {
    return false;
  }
  // 回合結束先送 awaiting_gate（review），Server 接著開始 Verification：只顯示驗證
  if (item.status === "awaiting_gate" && item.gate === "review" && next?.status === "verifying") {
    return false;
  }
  return true;
}

/** 權限請求的細節：觸發請求的 tool call 中的指令，沒有指令時是它碰到的檔案。 */
function permissionDetail(
  item: ItemOf<"permission">,
  tools: ReadonlyMap<string, ToolCallItem>,
): string | null {
  const tool = item.toolCallId ? tools.get(item.toolCallId) : undefined;
  if (!tool) return null;
  for (const content of tool.content) {
    if (content.type === "terminal" && content.command) return content.command;
  }
  const paths = tool.locations.map((l) => (l.line === null ? l.path : `${l.path}:${l.line}`));
  return paths.length > 0 ? paths.join("\n") : null;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Draft = DistributiveOmit<StreamItem, "head">;

/** 依時間軸產生串流的項目。 */
export function buildStream(items: readonly TimelineItem[], context: StreamContext): StreamItem[] {
  const tools = new Map<string, ToolCallItem>();
  const statuses: ItemOf<"status">[] = [];
  for (const item of items) {
    if (item.type === "tool_call") tools.set(item.toolCallId, item);
    if (item.type === "status") statuses.push(item);
  }

  const drafts: Draft[] = [];
  let group: ToolCallItem[] | null = null;
  let verification: Extract<Draft, { kind: "verification_group" }> | null = null;
  let statusIndex = 0;

  const flushGroup = () => {
    if (!group) return;
    const first = group[0] as ToolCallItem;
    drafts.push({ kind: "tool_group", key: `group-${first.key}`, ...summarizeTools(group) });
    group = null;
  };

  for (const item of items) {
    if (item.type === "tool_call") {
      verification = null;
      group ??= [];
      group.push(item);
      continue;
    }
    flushGroup();
    if (item.type === "verification_result") {
      if (!verification) {
        verification = {
          kind: "verification_group",
          key: `verification-${item.key}`,
          results: [],
          completed: null,
          passed: 0,
          failed: 0,
          defaultOpen: false,
        };
        drafts.push(verification);
      }
      verification.results.push(item);
      if (item.outcome === "passed") verification.passed += 1;
      else verification.failed += 1;
      verification.defaultOpen = verification.failed > 0;
      continue;
    }
    if (item.type === "verification_completed" && verification) {
      verification.completed = item.outcome;
      verification = null;
      continue;
    }
    verification = null;

    switch (item.type) {
      case "prompt":
        drafts.push({ kind: "prompt", key: item.key, item });
        break;
      case "message":
        drafts.push({ kind: "message", key: item.key, item });
        break;
      case "thought":
        drafts.push({ kind: "thought", key: item.key, item, live: false, seconds: null });
        break;
      case "plan": {
        const done = item.entries.filter((e) => e.status === "completed").length;
        const current =
          item.entries.find((e) => e.status === "in_progress") ??
          item.entries.find((e) => e.status === "pending");
        drafts.push({
          kind: "plan",
          key: item.key,
          item,
          done,
          total: item.entries.length,
          current: current?.content ?? null,
        });
        break;
      }
      case "plan_proposed":
        drafts.push({ kind: "plan_proposed", key: item.key, item });
        break;
      case "permission":
        drafts.push({
          kind: "permission",
          key: item.key,
          item,
          detail: permissionDetail(item, tools),
        });
        break;
      case "status": {
        const previous = statuses[statusIndex - 1];
        const next = statuses[statusIndex + 1];
        statusIndex += 1;
        if (showStatus(item, previous, next)) drafts.push({ kind: "status", key: item.key, item });
        break;
      }
      case "error":
        drafts.push({ kind: "error", key: item.key, item });
        break;
      case "rate_limited":
        drafts.push({ kind: "rate_limited", key: item.key, item });
        break;
      default:
        drafts.push({ kind: "system", key: item.key, item });
    }
  }
  flushGroup();

  // 思考的秒數與 live：看下一個項目的時間
  const live = isLive(context.status);
  const lastIndex = drafts.length - 1;
  drafts.forEach((draft, index) => {
    if (draft.kind === "thought") {
      const nextDraft = drafts[index + 1];
      const nextTs = nextDraft ? firstTs(nextDraft) : null;
      draft.live = index === lastIndex && live;
      draft.seconds = nextTs
        ? Math.max(1, seconds(draft.item.ts, nextTs))
        : draft.item.lastTs !== draft.item.ts
          ? Math.max(1, seconds(draft.item.ts, draft.item.lastTs))
          : null;
    }
    if (draft.kind === "tool_group") {
      // 自動展開：進行中，或是最後兩個項目之一
      draft.defaultOpen = context.autoExpandTools && (draft.running || index >= lastIndex - 1);
    }
  });

  let actor: StreamHead["actor"] | null = null;
  return drafts.map((draft) => {
    let head: StreamHead | null = null;
    if (draft.kind === "prompt") {
      actor = "user";
      head = { actor: "user", source: draft.item.source };
    } else if (AGENT_KINDS.has(draft.kind) && actor !== "agent") {
      actor = "agent";
      head = { actor: "agent" };
    }
    return { ...draft, head } as StreamItem;
  });
}

/** 一個項目在時間軸上最早的時間。 */
function firstTs(draft: Draft): string {
  switch (draft.kind) {
    case "tool_group":
      return (draft.tools[0] as ToolCallItem).ts;
    case "verification_group":
      return (draft.results[0] as VerificationResultItem).ts;
    default:
      return draft.item.ts;
  }
}

function summarizeTools(tools: ToolCallItem[]) {
  const counts: Record<ToolBucket, number> = { read: 0, search: 0, edit: 0, execute: 0, other: 0 };
  let running = false;
  let failed = 0;
  let first = (tools[0] as ToolCallItem).ts;
  let last = first;
  for (const tool of tools) {
    counts[toolBucket(tool.toolKind)] += 1;
    if (tool.status === "pending" || tool.status === "in_progress") running = true;
    if (tool.status === "failed") failed += 1;
    if (tool.ts < first) first = tool.ts;
    if (tool.lastTs > last) last = tool.lastTs;
  }
  const label: ToolGroupLabel = running
    ? "working"
    : counts.edit > 0
      ? "edited"
      : counts.execute > 0
        ? "executed"
        : "viewed";
  return {
    tools,
    running,
    failed,
    counts,
    label,
    durationSeconds: seconds(first, last),
    defaultOpen: false,
  };
}

/** 訊息中的文字（複製用）。非文字的區塊略過。 */
export function messageText(item: ItemOf<"message">): string {
  return item.blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

/**
 * 尾列：整個執行結束後（`isTurnFinished`），而且最後一則 Agent 回覆之後沒有人送出新的 prompt 時，
 * 顯示在那則回覆底下。
 */
export function streamTail(
  stream: readonly StreamItem[],
  context: Pick<StreamContext, "status" | "gate">,
  items: readonly TimelineItem[],
): StreamTail | null {
  if (!isTurnFinished(context.status, context.gate, items)) return null;
  let lastMessage: Extract<StreamItem, { kind: "message" }> | null = null;
  let promptBefore: string | null = null;
  let lastPrompt: string | null = null;
  for (const entry of stream) {
    if (entry.kind === "prompt") {
      lastPrompt = entry.item.ts;
      lastMessage = null;
    }
    if (entry.kind === "message") {
      lastMessage = entry;
      promptBefore = lastPrompt;
    }
  }
  if (!lastMessage) return null;
  const first = stream[0];
  const start = promptBefore ?? (first ? firstTs(first) : lastMessage.item.ts);
  return {
    messageKey: lastMessage.key,
    text: messageText(lastMessage.item),
    ts: lastMessage.item.lastTs,
    turnSeconds: seconds(start, lastMessage.item.lastTs),
  };
}
