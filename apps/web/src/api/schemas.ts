// 契約（packages/api-contract）還沒有、Web 需要的 Server↔Web 型別。
//
// TODO(contract): 協調者會對齊 B1 的端點後開 contract/web-api PR，把這些 schema 移進
// api-contract；合併後改為從 @orbis/api-contract import，並刪除這個檔案中對應的定義。

import {
  GateDecision,
  Id,
  PermissionPolicy,
  Role,
  RunEvent,
  RunnerKind,
  type TaskStatus,
} from "@orbis/api-contract";
import { z } from "zod";

/** Team 中的 Member（指派對象、留言作者等）。 */
export const Member = z.object({
  id: Id,
  githubLogin: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  role: Role,
});
export type Member = z.infer<typeof Member>;

/**
 * 看板上可以手動拖曳的 Task 狀態轉換（使用者決定：只有 Backlog ↔ Ready）。
 * 其他轉換由系統推進；Ready → Running 由派工觸發，不在這張表中。
 */
export const MANUAL_TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  backlog: ["ready"],
  ready: ["backlog"],
  planning: [],
  plan_gate: [],
  running: [],
  verifying: [],
  review_gate: [],
  pr_open: [],
  done: [],
};

/** 派工（建立 Run）。Task 由路徑決定。`yolo` 只能用在 Local Runner（§8、§18）。 */
export const CreateRunInput = z
  .object({
    /** Agent Profile 的 id，例如 `claude-code`。 */
    agent: z.string().min(1),
    /** 使用的 model；null 表示 Agent 的預設值。 */
    model: z.string().min(1).nullable(),
    runnerKind: RunnerKind,
    permissionPolicy: PermissionPolicy,
  })
  .strict()
  .refine((input) => input.permissionPolicy !== "yolo" || input.runnerKind === "local", {
    error: "Team Runner 不能使用 yolo",
    path: ["permissionPolicy"],
  });
export type CreateRunInput = z.infer<typeof CreateRunInput>;

/** 一個 Agent 是否能派工，由 Server 彙整各 Runner 回報的 AgentAvailability（camelCase）。 */
export const AgentOption = z.object({
  /** Agent Profile 的 id。 */
  id: z.string().min(1),
  version: z.string().nullable(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  models: z.array(z.string()),
  /** 這個 Agent 在 Permission Policy 下無法攔截的操作（ADR-0006）。 */
  permissionGaps: z.array(z.string()),
});
export type AgentOption = z.infer<typeof AgentOption>;

/** 某一種 Runner 目前能跑哪些 Agent。 */
export const DispatchTarget = z.object({
  /** 是否至少有一台這種 Runner 在線。 */
  online: z.boolean(),
  agents: z.array(AgentOption),
});
export type DispatchTarget = z.infer<typeof DispatchTarget>;

/** 派工對話框的選項。沒有完成 Pairing 的 Runner 種類為 null。 */
export const DispatchOptions = z.object({
  local: DispatchTarget.nullable(),
  team: DispatchTarget.nullable(),
});
export type DispatchOptions = z.infer<typeof DispatchOptions>;

/** 協定的 TextBody（snake_case，與 Event 內容相同，Server 不轉換）。 */
export const TextBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inline"), text: z.string() }),
  z.object({
    type: z.literal("blob"),
    blob_id: z.string().min(1),
    sha256: z.string(),
    size: z.number().int().nonnegative(),
    media_type: z.string(),
  }),
]);

export const DIFF_FILE_CHANGES = ["added", "modified", "deleted", "renamed"] as const;
export const DiffFileChange = z.enum(DIFF_FILE_CHANGES);
export type DiffFileChange = z.infer<typeof DiffFileChange>;

/** Review diff 中的一個檔案：base_commit 與 Worktree 目前的內容。 */
export const ReviewDiffFile = z.object({
  path: z.string().min(1),
  /** 改名前的路徑；沒有改名時為 null。 */
  oldPath: z.string().min(1).nullable(),
  change: DiffFileChange,
  /** 修改前的內容；新增檔案時為 null。 */
  old: TextBody.nullable(),
  /** 修改後的內容；刪除檔案時為 null。 */
  new: TextBody.nullable(),
});
export type ReviewDiffFile = z.infer<typeof ReviewDiffFile>;

/**
 * Run 在 Review Gate 時 base_commit..Worktree 的完整 diff（使用者決定：由 Runner 進入
 * Review Gate 時以新的 Event kind 送上來，Server 保存）。
 */
export const ReviewDiff = z.object({
  runId: Id,
  baseCommit: z.string().min(1),
  files: z.array(ReviewDiffFile),
});
export type ReviewDiff = z.infer<typeof ReviewDiff>;

export const REVIEW_COMMENT_SIDES = ["old", "new"] as const;

/** Diff 上的行內留言。`side` 是留言所在的一側（修改前或修改後），行號從 1 開始。 */
export const ReviewComment = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: z.enum(REVIEW_COMMENT_SIDES),
  body: z.string().trim().min(1),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

/** Review Gate 的決定。退回時附上的行內留言由 Server 打包成送給 Agent 的 prompt。 */
export const ReviewDecisionInput = z
  .object({
    decision: GateDecision,
    /** 整體說明。 */
    comment: z.string().trim().min(1).nullable().default(null),
    comments: z.array(ReviewComment).default([]),
  })
  .strict()
  .refine((input) => input.decision === "rejected" || input.comments.length === 0, {
    error: "核准時不能附上行內留言",
    path: ["comments"],
  });
export type ReviewDecisionInput = z.input<typeof ReviewDecisionInput>;

/** 回覆 Agent 的權限請求。 */
export const PermissionResponseInput = z
  .object({
    permissionRequestId: Id,
    optionId: z.string().min(1),
  })
  .strict();
export type PermissionResponseInput = z.infer<typeof PermissionResponseInput>;

/** `GET` Run 的 Event（依 seq 排序）。 */
export const RunEventsResponse = z.array(RunEvent);

/** Web → Server 的 WebSocket frame。 */
export const ClientFrame = z.discriminatedUnion("type", [
  /** 訂閱一個 Run 的 Event，Server 先重播 `fromSeq` 起已保存的 Event，再即時推送新的。 */
  z.object({ type: z.literal("subscribe"), runId: Id, fromSeq: z.number().int().positive() }),
  z.object({ type: z.literal("unsubscribe"), runId: Id }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/** Server → Web 的 WebSocket frame。 */
export const ServerFrame = z.discriminatedUnion("type", [
  /** 一批依 seq 排序的 Event（重播時一次送多筆）。 */
  z.object({ type: z.literal("events"), runId: Id, events: z.array(RunEvent) }),
  z.object({ type: z.literal("error"), runId: Id.nullable(), message: z.string() }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
