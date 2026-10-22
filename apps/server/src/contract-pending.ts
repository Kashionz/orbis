// 還沒進入契約（packages/api-contract、crates/orbis-protocol）的暫時型別。
// 協調者正在開 contract/web-api 與 contract/protocol 兩個契約 PR，合併後改用契約的定義並刪除這個檔案。
//
// TODO(contract): contract/web-api、contract/protocol 合併後移除本檔。

import {
  AcceptanceCriterionKind,
  ProjectPolicy as ContractProjectPolicy,
  DISPATCH_STATUSES,
  GateDecision,
  GateKind,
  Id,
  PermissionPolicy,
  ProjectKeyPrefix,
  Role,
  type RunEvent,
  RunnerKind,
  Timestamp,
} from "@orbis/api-contract";
import { z } from "zod";

// ---- 資源 ----

export const Team = z.object({
  id: Id,
  name: z.string().min(1),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Team = z.infer<typeof Team>;

export const Member = z.object({
  id: Id,
  teamId: Id,
  githubUserId: z.number().int(),
  githubLogin: z.string().min(1),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: Role,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Member = z.infer<typeof Member>;

/** Project 的政策：契約的 ProjectPolicy 加上預設的 Permission Policy。 */
export const ProjectPolicy = ContractProjectPolicy.extend({
  defaultPermissionPolicy: PermissionPolicy,
});
export type ProjectPolicy = z.infer<typeof ProjectPolicy>;

export const ProjectMemberRole = z.object({
  projectId: Id,
  memberId: Id,
  role: Role,
});
export type ProjectMemberRole = z.infer<typeof ProjectMemberRole>;

export const AgentAvailabilityItem = z.object({
  agent: z.string().min(1),
  credential: z.string(),
  available: z.boolean(),
  maxConcurrency: z.number().int().positive(),
  /** Runner 回報的其他資訊（版本、model、能力、無法使用的原因）。 */
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type AgentAvailabilityItem = z.infer<typeof AgentAvailabilityItem>;

export const Runner = z.object({
  id: Id,
  teamId: Id,
  kind: RunnerKind,
  /** Local Runner 綁定的 Member；Team Runner 為 null。 */
  memberId: Id.nullable(),
  name: z.string(),
  runnerVersion: z.string(),
  os: z.string(),
  arch: z.string(),
  /** 目前是否連線中。 */
  online: z.boolean(),
  /** Runner 目前是否接受新的 Dispatch（Desktop 的「暫停領取」）。 */
  acceptingDispatches: z.boolean(),
  lastHeartbeatAt: Timestamp.nullable(),
  agents: z.array(AgentAvailabilityItem),
  createdAt: Timestamp,
});
export type Runner = z.infer<typeof Runner>;

/** 建立 Pairing token 的回應；token 原文只在這裡出現一次。 */
export const PairingTokenCreated = z.object({
  id: Id,
  kind: RunnerKind,
  token: z.string().min(1),
  expiresAt: Timestamp,
});
export type PairingTokenCreated = z.infer<typeof PairingTokenCreated>;

/** Review Gate 退回時的行內留言。 */
export const ReviewComment = z.object({
  path: z.string().min(1),
  /** 從 1 開始的行號。 */
  line: z.number().int().positive(),
  /** 留言在 diff 的哪一側：`old`＝修改前，`new`＝修改後。 */
  side: z.enum(["old", "new"]),
  body: z.string().trim().min(1),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

export const Gate = z.object({
  id: Id,
  taskId: Id,
  runId: Id.nullable(),
  kind: GateKind,
  decision: GateDecision.nullable(),
  decidedByMemberId: Id.nullable(),
  decidedAt: Timestamp.nullable(),
  comment: z.string().nullable(),
  reviewComments: z.array(ReviewComment),
  createdAt: Timestamp,
});
export type Gate = z.infer<typeof Gate>;

export const DispatchStatus = z.enum(DISPATCH_STATUSES);

// ---- 輸入 ----

export const UpdateTeamInput = z.object({ name: z.string().trim().min(1) }).strict();

export const AddMemberInput = z
  .object({ githubLogin: z.string().trim().min(1), role: Role.default("member") })
  .strict();

export const UpdateMemberInput = z.object({ role: Role }).strict();

export const CreateProjectInput = z
  .object({
    name: z.string().trim().min(1),
    keyPrefix: ProjectKeyPrefix,
    description: z.string().default(""),
    policy: ProjectPolicy.partial().default({}),
  })
  .strict();

export const UpdateProjectInput = z
  .object({
    name: z.string().trim().min(1),
    description: z.string(),
    policy: ProjectPolicy.partial(),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, { error: "至少要更新一個欄位" });

/** Project 的 Role 覆寫不能是 Owner。 */
export const SetProjectRoleInput = z.object({ role: Role.exclude(["owner"]) }).strict();

/** GitHub 的使用者或組織名稱。 */
export const GitHubOwnerName = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, { error: "不是合法的 GitHub 使用者或組織名稱" });

/** GitHub 的 repository 名稱；不可以是 `.` 或 `..`（會被 Runner 用在 Worktree 路徑中）。 */
export const GitHubRepoName = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, { error: "不是合法的 GitHub repository 名稱" })
  .refine((name) => name !== "." && name !== "..", { error: "不是合法的 GitHub repository 名稱" });

/** git 分支名稱（git check-ref-format 規則的子集合，會被放進 git 指令的參數）。 */
export const GitBranchName = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      !name.startsWith("-") &&
      !name.startsWith("/") &&
      !name.endsWith("/") &&
      !name.endsWith(".") &&
      !name.endsWith(".lock") &&
      !name.includes("..") &&
      !name.includes("//") &&
      !name.includes("@{") &&
      name !== "@" &&
      !name.split("/").some((part) => part.startsWith(".")) &&
      // 控制字元、空白與 git 不允許的符號。
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 要排除的正是控制字元
      !/[\u0000- \u007f~^:?*[\\]/.test(name),
    { error: "不是合法的 git 分支名稱" },
  );

export const CreateRepoInput = z
  .object({
    owner: GitHubOwnerName,
    name: GitHubRepoName,
    defaultBranch: GitBranchName.default("main"),
  })
  .strict();

export const CreatePairingTokenInput = z.object({ kind: RunnerKind }).strict();

export const CreateRunInput = z
  .object({
    agent: z.string().trim().min(1),
    model: z.string().trim().min(1).nullable().default(null),
    runnerKind: RunnerKind,
    /** 未指定時用 Project 的預設政策。 */
    permissionPolicy: PermissionPolicy.optional(),
  })
  .strict();

export const RespondNeedsYouInput = z.object({ optionId: z.string().min(1) }).strict();

export const GateDecisionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }).strict(),
  z
    .object({
      action: z.literal("reject"),
      comment: z.string().trim().nullable().default(null),
      reviewComments: z.array(ReviewComment).default([]),
    })
    .strict()
    .refine((input) => (input.comment ?? "") !== "" || input.reviewComments.length > 0, {
      error: "退回時至少要有一則說明或行內留言",
    }),
  z.object({ action: z.literal("abort") }).strict(),
]);
export type GateDecisionInput = z.infer<typeof GateDecisionInput>;

export const AcceptanceCriterionKindInput = AcceptanceCriterionKind;

// ---- Web 即時推送（WebSocket `/api/ws`，只推 Run Event）----

export const WEB_WS_PATH = "/api/ws";

export const WebClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe_run"),
    runId: Id,
    /** 從這個 seq 之後開始送（不含）；0 表示從頭重播。 */
    afterSeq: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("unsubscribe_run"), runId: Id }),
]);
export type WebClientMessage = z.infer<typeof WebClientMessage>;

export type WebServerMessage =
  | { type: "run_event"; event: RunEvent }
  | {
      type: "error";
      code: "invalid_message" | "not_found" | "forbidden";
      message: string;
      runId: string | null;
    };

// ---- 協定（contract/protocol）----

/** Runner 上傳 blob 的 HTTP 路徑（`PUT <path>/:blobId`）。 */
export const RUNNER_BLOB_PATH = "/api/runner/blobs";

/** review diff Event 的 kind。 */
export const REVIEW_DIFF_EVENT_KIND = "review_diff";
