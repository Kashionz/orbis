// Run、Child Run、Event、Dispatch、blob 參照（ARCHITECTURE §4、§6.1、§9、§14）。

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz, updatedAt } from "./columns";
import {
  delegationModeEnum,
  dispatchStatusEnum,
  permissionPolicyEnum,
  runControlActionEnum,
  runnerKindEnum,
  runOriginEnum,
  runStatusEnum,
} from "./enums";
import { runners } from "./runner";
import { tasks } from "./task";
import { members } from "./team";

/**
 * Run：某個 Agent 為某個 Task 做的一次執行。一個 Task 可以有多個 Run（含平行的 best-of-N）。
 * Child Run 是 parent_run_id 不為 null 的 Run；深度最多 2 層、同時最多 5 個 Child Run，
 * 都由應用層檢查。
 */
export const runs = pgTable(
  "runs",
  {
    id: id(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    parentRunId: uuid("parent_run_id").references((): AnyPgColumn => runs.id, {
      onDelete: "cascade",
    }),
    /**
     * Delegation 模式。Child Run 一定有值；沒有父 Run 的 `consult` Run
     * （例如判定 `agent` 類型的 Acceptance Criterion、@agent）也可以有值。
     */
    delegationMode: delegationModeEnum("delegation_mode"),
    /** Agent 的識別名稱，例如 `claude-code`。 */
    agent: text("agent").notNull(),
    model: text("model"),
    permissionPolicy: permissionPolicyEnum("permission_policy").notNull(),
    status: runStatusEnum("status").notNull().default("queued"),
    /** 要在哪裡跑：`local`＝負責人的 Local Runner，`team`＝Team 佇列。 */
    target: runnerKindEnum("target").notNull(),
    /** 派工的 Member；`local` 的 Run 只會交給這位 Member 的 Local Runner。 */
    requestedByMemberId: uuid("requested_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    /** 目前（或最後）執行這個 Run 的 Runner。 */
    runnerId: uuid("runner_id").references(() => runners.id, { onDelete: "set null" }),
    /** 以下由 Runner 在開始執行後回報。worktree_path 是 Runner 主機上的路徑。 */
    worktreePath: text("worktree_path"),
    branch: text("branch"),
    baseCommit: text("base_commit"),
    /** 累計用量（tokens、費用等），格式依協定的 `usage` Event 保留彈性。 */
    usage: jsonb("usage").notNull().default(sql`'{}'::jsonb`),
    /** Run 為什麼產生（協定的 RunOrigin）。 */
    origin: runOriginEnum("origin").notNull().default("dispatch"),
    /** 派工時 Server 選定的 Credential（Runner 上的名稱）；還沒派工時為 null。 */
    credential: text("credential"),
    /** 沒有父 Run 的 `consult` Run（@agent）唯讀讀取哪個 Run 的 Worktree。 */
    consultOfRunId: uuid("consult_of_run_id").references((): AnyPgColumn => runs.id, {
      onDelete: "set null",
    }),
    /** Feedback Loop 的 Run 接續的前一個 Run（同一個 Worktree、分支與 session）。 */
    resumesRunId: uuid("resumes_run_id").references((): AnyPgColumn => runs.id, {
      onDelete: "set null",
    }),
    /** Runner 以 `agent_session` Event 回報的 ACP session id，Feedback Loop 的新 Run 以此 resume。 */
    agentSessionId: text("agent_session_id"),
    /**
     * 第一個 prompt（協定的 `ContentBlock[]`）；null 表示由 Task 組出。Child Run（`delegate` 的 prompt）、
     * @agent 的 consult Run、Feedback Loop 的 Run 的 prompt 不是 Task，存在這裡，排隊、改派、
     * Server 重新啟動後派工都拿得到。
     */
    prompt: jsonb("prompt"),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("runs_task_id_idx").on(t.taskId),
    index("runs_parent_run_id_idx").on(t.parentRunId),
    index("runs_status_idx").on(t.status),
    index("runs_resumes_run_id_idx").on(t.resumesRunId),
    check(
      "runs_child_has_delegation_mode",
      sql`${t.parentRunId} IS NULL OR ${t.delegationMode} IS NOT NULL`,
    ),
    check("runs_not_own_parent", sql`${t.parentRunId} IS NULL OR ${t.parentRunId} <> ${t.id}`),
  ],
);

/**
 * Event：Run 過程中由 Runner 正規化後送來的紀錄（ARCHITECTURE §14）。
 * seq 在每個 Run 內從 1 開始，(run_id, seq) 為主鍵，重送的 Event 以此去除重複。
 * kind 對應協定的 Event kind；payload 是協定 Event 的內容（JSONB）。
 */
export const runEvents = pgTable(
  "run_events",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    /** Runner 產生 Event 的時間。 */
    ts: timestamptz("ts").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    /** Server 收到的時間。 */
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    check("run_events_seq_positive", sql`${t.seq} >= 1`),
  ],
);

/**
 * Dispatch：Server 把一個待執行的 Run 交給某個 Runner 的一次指派。
 * id 就是 Dispatch ID；過了 expires_at 仍未接受，或已過期的 Dispatch 回報的結果一律拒絕。
 */
export const dispatches = pgTable(
  "dispatches",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    status: dispatchStatusEnum("status").notNull().default("offered"),
    expiresAt: timestamptz("expires_at").notNull(),
    respondedAt: timestamptz("responded_at"),
    /** Runner 拒絕時附上的原因。 */
    rejectReason: text("reject_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("dispatches_run_id_idx").on(t.runId),
    index("dispatches_runner_id_status_idx").on(t.runnerId, t.status),
  ],
);

/**
 * 送給 Runner 的 RunControl（ARCHITECTURE §6.1）：每個指令一筆，以 control_id 對應 Runner 回的
 * run_control_result。outcome 為 null 表示還沒有結果；Runner 重新連線後補送這些指令。
 */
export const runControls = pgTable(
  "run_controls",
  {
    /** 協定的 control_id。 */
    controlId: uuid("control_id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    dispatchId: uuid("dispatch_id")
      .notNull()
      .references(() => dispatches.id, { onDelete: "cascade" }),
    action: runControlActionEnum("action").notNull(),
    /** 指令的完整內容（協定的 RunControlAction）。 */
    payload: jsonb("payload").notNull(),
    /** 送出這個指令的 Member；系統觸發時為 null。 */
    requestedByMemberId: uuid("requested_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    sentAt: timestamptz("sent_at"),
    /** 協定 RunControlOutcome 的種類：applied、branch_pushed、rejected。 */
    outcome: text("outcome"),
    /** RunControlOutcome 的完整內容，例如 push 的 commit SHA 或拒絕原因。 */
    outcomePayload: jsonb("outcome_payload"),
    resolvedAt: timestamptz("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("run_controls_run_id_idx").on(t.runId),
    index("run_controls_pending_idx").on(t.dispatchId).where(sql`${t.resolvedAt} IS NULL`),
    check("run_controls_outcome_complete", sql`(${t.outcome} IS NULL) = (${t.resolvedAt} IS NULL)`),
    check(
      "run_controls_outcome_known",
      sql`${t.outcome} IS NULL OR ${t.outcome} IN ('applied', 'branch_pushed', 'rejected')`,
    ),
  ],
);

/**
 * blob 參照：大型內容（完整檔案、截圖）存在 blob 儲存，Event 只放 BlobRef。
 * id 即協定 BlobRef 的 blob_id。預設保存 90 天，到期由清理工作刪除。
 */
export const blobs = pgTable(
  "blobs",
  {
    id: id(),
    sha256: text("sha256").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    mediaType: text("media_type").notNull(),
    /** 在 blob 儲存中的位置，格式由儲存實作決定。 */
    storageKey: text("storage_key").notNull(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    expiresAt: timestamptz("expires_at").notNull().default(sql`now() + interval '90 days'`),
  },
  (t) => [
    index("blobs_run_id_idx").on(t.runId),
    index("blobs_expires_at_idx").on(t.expiresAt),
    check("blobs_size_non_negative", sql`${t.size} >= 0`),
  ],
);
