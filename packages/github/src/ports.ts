// 這個套件需要 Server（B 軌）提供的介面。Server 用 Drizzle 與 Task 狀態機實作；
// 測試用 src/testing/ 中的 fake 實作。
//
// TODO(contract): GitHubStore 需要的資料表（task_issue_links、github_webhook_deliveries、
// pull_requests、repos.github_installation_id）由協調者的契約 PR `contract/db` 加入。
// TODO(contract): `tasks.done_reason` 與 `projects.auto_create_issues` 也在同一個契約 PR；
// 合併後 `TaskDoneReason` 改用 `@orbis/api-contract` 的定義。

import type {
  AcceptanceCriterionKind,
  AcceptanceCriterionResult,
  TaskStatus,
} from "@orbis/api-contract";

// ── Server 提供的領域資料 ─────────────────────────────────────

/** Task 轉為 Done 的原因（ARCHITECTURE §11），取自 GitHub Issue 關閉時的 `state_reason`。 */
export type TaskDoneReason = "completed" | "not_planned";

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
  /** TODO(contract): `repos.github_installation_id`。 */
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
export type GitHubNotificationKind = "pr_merged" | "pr_closed_unmerged" | "pr_open_failed";

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

export type PullRequestState = "open" | "closed" | "merged";

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
  /** 以 taskId 新增或覆蓋。 */
  saveIssueLink(link: IssueLink): Promise<void>;
  deleteIssueLink(taskId: string): Promise<void>;

  findPullRequestLink(githubRepoId: number, number: number): Promise<PullRequestLink | null>;
  /** 以 (githubRepoId, number) 新增或覆蓋。 */
  savePullRequestLink(link: PullRequestLink): Promise<void>;
}

/** 結構化 log，與 pino 相容。 */
export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
