// 這個套件需要 Server（B 軌）提供的介面。Server 用 Drizzle 與 Task 狀態機實作；
// 測試用 src/testing/ 中的 fake 實作。
//
// GitHubStore 的資料表定義在 apps/server/src/db/schema/github.ts（task_issue_links、
// github_webhook_deliveries、pull_requests），另外用到 repos.github_installation_id、
// tasks.done_reason、projects.auto_create_issues。

import type {
  AcceptanceCriterionKind,
  AcceptanceCriterionResult,
  PullRequestState,
  TaskDoneReason,
  TaskStatus,
} from "@orbis/api-contract";

export type { PullRequestState, TaskDoneReason };

// ── Server 提供的領域資料 ─────────────────────────────────────

/** Task 中與 GitHub 有關的欄位。 */
export interface TaskRecord {
  id: string;
  key: string;
  projectId: string;
  repoId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  /** 轉為 Done 的原因；不是 Done 時為 null。 */
  doneReason: TaskDoneReason | null;
  assigneeMemberId: string | null;
  createdByMemberId: string | null;
  labels: string[];
  /** Repo 內 Spec 的路徑（以 `/` 分隔）；沒有時為 null。 */
  specPath: string | null;
  updatedAt: Date;
}

export interface RepoRecord {
  id: string;
  projectId: string;
  owner: string;
  name: string;
  githubRepoId: number | null;
  defaultBranch: string | null;
  /** `repos.github_installation_id`；沒有安裝 App 時為 null。 */
  installationId: number | null;
}

export interface MemberRecord {
  id: string;
  githubUserId: number;
  githubLogin: string;
}

export interface AcceptanceCriterionRecord {
  kind: AcceptanceCriterionKind;
  description: string;
  result: AcceptanceCriterionResult;
}

export interface RunSummary {
  id: string;
  agent: string;
  status: string;
}

/**
 * 由 GitHub 觸發的狀態轉換的原因，Server 可以記錄在 Task 的歷程中。
 * 轉為 Done 時帶有 `doneReason`，Server 寫進 Task；離開 Done 時 Server 清空關閉原因。
 */
export type TransitionCause =
  | { kind: "issue_closed"; issueUrl: string; byGithubLogin: string; doneReason: TaskDoneReason }
  | { kind: "issue_reopened"; issueUrl: string; byGithubLogin: string }
  | { kind: "pr_merged"; pullRequestUrl: string; doneReason: "completed" }
  | { kind: "pr_closed"; pullRequestUrl: string; byGithubLogin: string }
  | { kind: "pr_reopened"; pullRequestUrl: string };

export type TransitionResult =
  | { ok: true; task: TaskRecord }
  /**
   * `active_run`：Task 有進行中的 Run（例如在 GitHub 上關閉 Issue 時）。
   * `invalid_transition`：狀態機不允許這個轉換。
   */
  | { ok: false; reason: "active_run" | "invalid_transition" };

/** 從 GitHub 寫回 Task 的欄位。 */
export interface TaskFieldsPatch {
  title?: string;
  description?: string;
  assigneeMemberId?: string | null;
  labels?: string[];
  /** 只會在 Task 已經是 Done 時送出：GitHub 上改了已關閉 Issue 的關閉原因。 */
  doneReason?: TaskDoneReason;
}

/**
 * Server 提供的 domain service。
 *
 * **重要**：由這個介面發起的寫入（`createTaskFromIssue`、`updateTaskFields`、`transitionTask`）
 * Server 不要再呼叫 `GitHubIntegration.onTaskChanged`。就算呼叫了也不會寫出重複的變更
 * （與同步快照相同就不寫），但會多打 GitHub API。
 */
export interface DomainService {
  getTask(taskId: string): Promise<TaskRecord | null>;
  getRepo(repoId: string): Promise<RepoRecord | null>;
  /** 同一個 GitHub repo 可能登記在多個 Project。 */
  listReposByGithubRepoId(githubRepoId: number): Promise<RepoRecord[]>;
  listReposByInstallationId(installationId: number): Promise<RepoRecord[]>;
  /**
   * 以 owner/name 找 Repo（不分大小寫）。用於 App 安裝之前登記、還不知道 GitHub repo id 的 Repo：
   * 安裝事件以名稱比對，再補上 repo id 與 installation。
   */
  listReposByFullName(owner: string, name: string): Promise<RepoRecord[]>;
  /** 更新 Repo 的 GitHub 資訊（安裝狀態、repo id、default branch）。 */
  updateRepoGitHubInfo(
    repoId: string,
    info: { installationId?: number | null; githubRepoId?: number; defaultBranch?: string },
  ): Promise<void>;

  /** 從 Issue 匯入成 Task：狀態一律是 Backlog，Task Key 由 Server 產生。 */
  createTaskFromIssue(input: {
    repoId: string;
    title: string;
    description: string;
    labels: string[];
    assigneeMemberId: string | null;
    createdByMemberId: string;
  }): Promise<TaskRecord>;
  updateTaskFields(taskId: string, patch: TaskFieldsPatch): Promise<TaskRecord>;
  /** 要求狀態轉換，是否合法由 Server 的狀態機判斷。 */
  transitionTask(taskId: string, to: TaskStatus, cause: TransitionCause): Promise<TransitionResult>;

  listAcceptanceCriteria(taskId: string): Promise<AcceptanceCriterionRecord[]>;
  /** Task 最近一次的 Run（顯示在狀態摘要留言）；沒有時回傳 null。 */
  getLatestRun(taskId: string): Promise<RunSummary | null>;

  getMember(memberId: string): Promise<MemberRecord | null>;
  /** 在 Project 所屬的 Team 中，找出這個 GitHub 帳號對應的 Member。 */
  findMemberByGithubUserId(projectId: string, githubUserId: number): Promise<MemberRecord | null>;
  /** 這位 Member 在這個 Project 能不能編輯 Task（考慮 Project 的 Role 覆寫；Viewer 不行）。 */
  canEditTasks(projectId: string, memberId: string): Promise<boolean>;
  /**
   * Project 是否開啟「自動建立 Issue」（預設開啟）。關閉時不為 Task 建立新的 Issue，
   * 但已經對應的 Issue（包括匯入的）照常同步。
   */
  autoCreateIssues(projectId: string): Promise<boolean>;
}

/** 通知的種類（ARCHITECTURE §12.3「自己的 Task 被 merge 或被退回」）。 */
export type GitHubNotificationKind =
  | "pr_merged"
  | "pr_closed_unmerged"
  | "pr_open_failed"
  /** Feedback Loop 達到次數上限（§12.3）。 */
  | "feedback_limit_reached";

export interface Notifier {
  notify(notification: {
    memberId: string;
    kind: GitHubNotificationKind;
    taskId: string;
    message: string;
    url?: string;
  }): Promise<void>;
}

// ── 這個套件自己的持久化資料（由 Server 以 Drizzle 實作）────────────

export type SyncedField = "title" | "body" | "state" | "assignee" | "labels";

/**
 * 上次同步時 Issue 的欄位值，以及各欄位最後一次同步時 Issue 的 `updated_at`。
 * 用來判斷一則 webhook 中哪些欄位真的被改了、哪些是自己寫出去的回音、哪些是過期的 payload。
 */
/** 同步欄位 `state` 的值：Issue 打開，或以哪個原因關閉。 */
export type IssueSyncState = "open" | TaskDoneReason;

export interface IssueSnapshot {
  title: string;
  body: string;
  state: IssueSyncState;
  /** 對應到 Task 負責人的 GitHub user id；沒有時為 null。 */
  assignee: number | null;
  /** 排序過的 label 名稱。 */
  labels: string[];
  /** 各欄位最後一次同步時 Issue 的 `updated_at`（ISO 8601）。 */
  syncedAt: Record<SyncedField, string>;
}

/** Task 與 Issue 的對應。一個 Task 最多對應一個 Issue。 */
export interface IssueLink {
  taskId: string;
  repoId: string;
  githubRepoId: number;
  issueNumber: number;
  issueId: number;
  issueUrl: string;
  /** 狀態摘要留言的 comment id；還沒建立或已被刪除時為 null。 */
  summaryCommentId: number | null;
  /** 上次寫出的摘要留言內容的雜湊，相同就不再更新。 */
  summaryHash: string | null;
  snapshot: IssueSnapshot;
}

/** 以 App 身分開出的 PR 與 Task 的對應。 */
export interface PullRequestLink {
  taskId: string;
  /** 開出這個 PR 的 Run；Run 被刪除後為 null。 */
  runId: string | null;
  repoId: string;
  githubRepoId: number;
  number: number;
  url: string;
  headBranch: string;
  headSha: string;
  state: PullRequestState;
}

export type DeliveryClaim =
  /** 第一次收到（或先前處理失敗、處理逾時），可以處理。 */
  | "claimed"
  /** 已經處理完成。 */
  | "duplicate"
  /** 另一個請求正在處理。 */
  | "in_progress";

export interface GitHubStore {
  /**
   * 搶下一個 webhook delivery 的處理權。同一個 delivery ID 同時只有一個請求能拿到 `claimed`；
   * 處理中的紀錄超過 `staleAfterMs` 沒有完成，視為處理者已經掛掉，可以重新搶。
   */
  claimDelivery(input: {
    deliveryId: string;
    event: string;
    now: Date;
    staleAfterMs: number;
  }): Promise<DeliveryClaim>;
  completeDelivery(deliveryId: string, now: Date): Promise<void>;
  /** 處理失敗：放掉處理權，讓 GitHub 的 redelivery 可以重新處理。 */
  releaseDelivery(deliveryId: string): Promise<void>;

  getIssueLinkByTask(taskId: string): Promise<IssueLink | null>;
  /** 同一個 Issue 可能對應不同 Project 的 Task。 */
  findIssueLinks(githubRepoId: number, issueNumber: number): Promise<IssueLink[]>;
  /**
   * 以 taskId 新增或覆蓋。同一個 Repo（`repoId`）中，這個 Issue 已經對應到別的 Task 時丟出
   * `IssueAlreadyLinkedError`（DB 的 `unique(repo_id, issue_number)`）。
   */
  saveIssueLink(link: IssueLink): Promise<void>;
  deleteIssueLink(taskId: string): Promise<void>;

  findPullRequestLink(githubRepoId: number, number: number): Promise<PullRequestLink | null>;
  /** 以 (githubRepoId, number) 新增或覆蓋。 */
  savePullRequestLink(link: PullRequestLink): Promise<void>;
}

/**
 * Feedback Loop 的持久化資料（由 Server 以 Drizzle 實作，要通過 `describeFeedbackStoreContract`）。
 * 同一個 PR 的讀寫由這個套件序列化（單一 Server 程序內）。
 */
export interface FeedbackStore {
  getFeedbackBatch(
    githubRepoId: number,
    prNumber: number,
    source: FeedbackSource,
  ): Promise<FeedbackBatch | null>;
  /** 以 (githubRepoId, prNumber, source) 新增或覆蓋。 */
  saveFeedbackBatch(batch: FeedbackBatch): Promise<void>;
  deleteFeedbackBatch(
    githubRepoId: number,
    prNumber: number,
    source: FeedbackSource,
  ): Promise<void>;
  /** `dueAt` 不晚於 `now` 的批次，依 `dueAt` 排序。 */
  listDueFeedbackBatches(now: Date): Promise<FeedbackBatch[]>;

  /** 以 id 新增或覆蓋。 */
  saveFeedbackFix(fix: FeedbackFix): Promise<void>;
  /** 這個 PR 的所有自動修正紀錄，依建立時間排序。 */
  listFeedbackFixes(githubRepoId: number, prNumber: number): Promise<FeedbackFix[]>;
  /** 由這個 Run 執行的修正。 */
  findFeedbackFixByRun(runId: string): Promise<FeedbackFix | null>;
}

/** 同一個 Repo 中，這個 Issue 已經對應到別的 Task。 */
export class IssueAlreadyLinkedError extends Error {
  override name = "IssueAlreadyLinkedError";
  constructor(
    readonly repoId: string,
    readonly issueNumber: number,
  ) {
    super(`Repo ${repoId} 的 Issue #${issueNumber} 已經對應到別的 Task`);
  }
}

// ── Feedback Loop（ARCHITECTURE §5.2）──────────────────────────────

/** Feedback Loop 的觸發來源，各自計算自動修正的次數。 */
export type FeedbackSource = "review" | "ci";

/** 一則會送回 Agent 的 review 回饋。 */
export interface ReviewFeedbackItem {
  /** `review`：review 本身的內容；`review_comment`：行內留言；`pr_comment`：PR 對話串的留言。 */
  kind: "review" | "review_comment" | "pr_comment";
  /** review id 或留言 id（依 `kind`）。 */
  id: number;
  /** 所屬的 review；PR 對話串的留言是 null。 */
  reviewId: number | null;
  /** 留言者的 GitHub login。 */
  author: string;
  body: string;
  url: string;
  /** 以下只有行內留言才有。 */
  path: string | null;
  line: number | null;
  startLine: number | null;
  diffHunk: string | null;
}

/** 一個失敗的 CI check。 */
export interface CiFeedbackItem {
  checkRunId: number;
  name: string;
  conclusion: string;
  /** 建立這個 check 的 App，例如 `github-actions`（決定怎麼讀 log）。 */
  appSlug: string;
  url: string;
  outputTitle: string | null;
  outputSummary: string | null;
}

interface FeedbackBatchBase {
  githubRepoId: number;
  prNumber: number;
  /** 可以送出的時間：review 送出時是當下；零散的留言是最後一則之後 2 分鐘。 */
  dueAt: Date;
}

/**
 * 等著送回 Agent 的一批回饋。每個 PR 每種來源最多一批，新的回饋併進同一批。
 * 前一次自動修正還沒完成時，到期的批次也先留著，修正完成後再送。
 */
export type FeedbackBatch =
  | (FeedbackBatchBase & { source: "review"; items: ReviewFeedbackItem[] })
  | (FeedbackBatchBase & {
      source: "ci";
      /** 這批 check 所屬的 commit；不是 PR 目前的 head 時整批作廢。 */
      headSha: string;
      items: CiFeedbackItem[];
    });

/**
 * 一次自動修正的紀錄。
 * - `sent`：已經交給 Server 開新的 Run 修正，等待 push。同一個 PR 同時只有一筆 `sent`。
 * - `pushed`：修正已經 push。
 * - `failed`：沒有開成 Run，或 Run 沒有 push 就結束。
 * - `limit_reached`：這個來源已經達到次數上限，沒有送出（每個 PR 每種來源只記一筆）。
 */
export type FeedbackFixStatus = "sent" | "pushed" | "failed" | "limit_reached";

export interface FeedbackFix {
  id: string;
  taskId: string;
  githubRepoId: number;
  prNumber: number;
  source: FeedbackSource;
  /** 要接續 session 的 Run（PR 目前對應的 Run）。 */
  previousRunId: string | null;
  /** 執行這次修正的新 Run；沒有開成時是 null。 */
  runId: string | null;
  /** 觸發這次修正的回饋。CI 的批次同時記錄 commit，用來避免同一個 check 重複觸發。 */
  trigger: FeedbackBatch;
  status: FeedbackFixStatus;
  /** 修正 push 出去的 commit（`pushed` 時）。 */
  commitSha: string | null;
  /** PR 上這次修正的紀錄留言；push 後在同一則留言補上新的 commit。留言失敗時為 null。 */
  prCommentId: number | null;
  /** 失敗的原因（`failed` 時）。 */
  message: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 請 Server 開新的 Run 修正 PR 上的回饋（ARCHITECTURE §5.2）。 */
export interface FeedbackFixRequest {
  taskId: string;
  /** 要接續 session 的 Run：開出 PR 或上一次修正的 Run。 */
  previousRunId: string;
  source: FeedbackSource;
  /** 修正 prompt（markdown）。 */
  prompt: string;
  pullRequestUrl: string;
}

export type FeedbackFixResult =
  | { ok: true; runId: string }
  | {
      ok: false;
      /**
       * `run_not_found`：要接續的 Run 不存在。
       * `run_not_resumable`：沒有 Runner 能接續（例如 Runner 離線、Worktree 已清除）。
       * `invalid_state`：Task 不在 PR Open（例如有人正在處理）。
       */
      reason: "run_not_found" | "run_not_resumable" | "invalid_state";
      message: string;
    };

/**
 * Server（B 軌）提供：開一個新的 Run（origin 為 `feedback_loop`，連到 `previousRunId`，同一個 Runner、
 * 分支與 Worktree，resume 原本的 session）並送出修正 prompt。Task 轉回 Running，修正經過 Verifying，
 * 通過後直接 push、不經過 Review Gate。push 完成後 Server 照常呼叫 `onBranchPushed`；
 * Run 沒有 push 就結束時呼叫 `onFeedbackRunEnded`。
 */
export interface FeedbackRunPort {
  requestFix(request: FeedbackFixRequest): Promise<FeedbackFixResult>;
}

/** Feedback Loop 需要 Server 提供的依賴。沒有提供時 Feedback Loop 停用（相關 webhook 一律略過）。 */
export interface FeedbackDependencies {
  store: FeedbackStore;
  runs: FeedbackRunPort;
  /**
   * Project 設定的 bot 白名單（GitHub login，例如 `coderabbitai[bot]`）。只有白名單中的 bot 留言會觸發
   * Feedback Loop（ARCHITECTURE §5.2）；比對不分大小寫。
   */
  botAllowlist(projectId: string): Promise<string[]>;
  /** 在 Task 上留下一筆 Task note（source 為 `feedback_loop`），每次自動修正一筆。 */
  addTaskNote(note: {
    taskId: string;
    /** 修正用的 Run；沒有開成 Run 時為 null。 */
    runId: string | null;
    /** markdown。 */
    body: string;
    /** PR 上的紀錄留言；沒有時是 PR 本身。 */
    url: string | null;
  }): Promise<void>;
}

// ── Repo Spec 提交到 repo（ARCHITECTURE §12.1）─────────────────────────

/**
 * Repo 內的 Spec 檔（RepoSpec）中與提交有關的欄位。
 * TODO(contract): 版本相關欄位（version、committedSha、committedBlobSha）等契約 v2 的 repo_specs 合併後對齊名稱。
 */
export interface RepoSpecRecord {
  id: string;
  repoId: string;
  /** Repo 內的相對路徑，以 `/` 分隔。 */
  path: string;
  title: string | null;
  /** 從 Orbis 提交、已經 merge 的次數；還沒提交過是 0。 */
  version: number;
  /** 上一次 merge 的 commit；還沒提交過是 null。 */
  committedSha: string | null;
  /** 上一次 merge 後檔案的 blob SHA，用來判斷 repo 中的檔案之後有沒有被別人改過。 */
  committedBlobSha: string | null;
}

/** 從 Orbis 提交 Repo Spec 開出的 PR。 */
export interface RepoSpecPullRequest {
  repoSpecId: string;
  githubRepoId: number;
  number: number;
  url: string;
  headBranch: string;
  state: PullRequestState;
  /** 第一次提交的 Member。 */
  createdByMemberId: string | null;
}

/** Spec PR 的對應（由 Server 以 Drizzle 實作，要通過 `describeRepoSpecStoreContract`）。 */
export interface RepoSpecStore {
  findRepoSpecPullRequest(
    githubRepoId: number,
    number: number,
  ): Promise<RepoSpecPullRequest | null>;
  /** 這份 Spec 還開著的 PR；最多一個。 */
  findOpenRepoSpecPullRequest(repoSpecId: string): Promise<RepoSpecPullRequest | null>;
  /** 以 (githubRepoId, number) 新增或覆蓋。 */
  saveRepoSpecPullRequest(pr: RepoSpecPullRequest): Promise<void>;
}

/** Repo Spec 提交需要 Server 提供的依賴。沒有提供時 `commitRepoSpec` 回傳 `disabled`。 */
export interface RepoSpecDependencies {
  store: RepoSpecStore;
  getRepoSpec(repoSpecId: string): Promise<RepoSpecRecord | null>;
  /**
   * Spec PR merge 之後：版本 +1（Server 以原子操作遞增），記錄 merge commit 與檔案的 blob SHA。
   * 回傳新的版本。
   */
  recordRepoSpecMerged(
    repoSpecId: string,
    merged: { commitSha: string; blobSha: string | null; pullRequestUrl: string },
  ): Promise<{ version: number }>;
}

/** 結構化 log，與 pino 相容。 */
export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
