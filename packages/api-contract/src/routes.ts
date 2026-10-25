// Server REST 與 WebSocket 的路徑。Server（Hono 路由）、Web、MSW 假後端與 Desktop 共用同一份。
//
// 路徑中的參數以 `:name` 表示，Server 直接拿來註冊路由；呼叫端用 `apiPath()` 代入參數。

export const API_ROUTES = {
  health: "/api/health",

  authMe: "/api/auth/me",
  authGithubLogin: "/api/auth/github/login",
  authGithubCallback: "/api/auth/github/callback",
  authLogout: "/api/auth/logout",

  team: "/api/team",
  members: "/api/members",
  member: "/api/members/:memberId",

  projects: "/api/projects",
  project: "/api/projects/:projectId",
  projectRole: "/api/projects/:projectId/roles/:memberId",
  projectRepos: "/api/projects/:projectId/repos",
  repo: "/api/repos/:repoId",
  projectTasks: "/api/projects/:projectId/tasks",
  /** 查詢參數 `taskId`（選填）：依那個 Task 的 Repo 判斷能派到哪裡（本機 Repo）。 */
  projectDispatchOptions: "/api/projects/:projectId/dispatch-options",
  /** GET：看板每個 Task 的最新主 Run 與驗收進度。 */
  projectBoardSummary: "/api/projects/:projectId/board-summary",

  /** GET：Agent 提出、還沒確認的 Draft Task。 */
  projectDraftTasks: "/api/projects/:projectId/draft-tasks",
  /** POST：批次確認 Draft Task。 */
  projectDraftTasksConfirm: "/api/projects/:projectId/draft-tasks/confirm",
  /** POST：批次捨棄 Draft Task。 */
  projectDraftTasksDismiss: "/api/projects/:projectId/draft-tasks/dismiss",
  /** GET：@mention 自動完成的候選對象。 */
  projectMentionCandidates: "/api/projects/:projectId/mention-candidates",
  /** GET：Project 的 Role 覆寫清單（單筆的設定與刪除用 `projectRole`）。 */
  projectRoles: "/api/projects/:projectId/roles",
  /**
   * POST：重新讀取 Repo 的 GitHub App 安裝狀態。成功回更新後的 `Repo`；GitHub 上同名 repo 的 id
   * 與登記時不同時回 409，`error` 為 `repo_mismatch`。
   */
  repoRefreshInstallation: "/api/repos/:repoId/github/refresh",
  /** POST：本機 Repo 改成 GitHub Repo（只能單向）。 */
  repoConnectGithub: "/api/repos/:repoId/connect-github",
  /** GET／POST：Repo 的 Spec 清單與登記。 */
  repoSpecs: "/api/repos/:repoId/specs",
  repoSpec: "/api/repo-specs/:repoSpecId",
  /** POST：把 Spec 草稿提交到 repo（開 PR）。 */
  repoSpecCommit: "/api/repo-specs/:repoSpecId/commit",

  task: "/api/tasks/:taskId",
  taskByKey: "/api/tasks/by-key/:taskKey",
  taskTransition: "/api/tasks/:taskId/transition",
  taskAcceptanceCriteria: "/api/tasks/:taskId/acceptance-criteria",
  acceptanceCriterion: "/api/acceptance-criteria/:criterionId",
  taskRuns: "/api/tasks/:taskId/runs",
  taskGates: "/api/tasks/:taskId/gates",
  taskNotes: "/api/tasks/:taskId/notes",
  /** GET：Task 上所有的 @mention（含共同編輯文件中的 mention 節點與 @agent 建立的 Run）。 */
  taskMentions: "/api/tasks/:taskId/mentions",
  /** GET／POST：Task 留言。 */
  taskComments: "/api/tasks/:taskId/comments",
  /** PATCH／DELETE：修改或刪除自己的留言。 */
  taskComment: "/api/task-comments/:commentId",
  /** POST：在 Review Gate 為 `manual` 條件打勾。 */
  acceptanceCriterionCheck: "/api/acceptance-criteria/:criterionId/check",
  /** PATCH：修改 Draft Task。 */
  draftTask: "/api/draft-tasks/:draftTaskId",
  draftTaskConfirm: "/api/draft-tasks/:draftTaskId/confirm",
  draftTaskDismiss: "/api/draft-tasks/:draftTaskId/dismiss",
  /** GET：Task 的分享（成員、待接受的邀請、一般存取）。 */
  taskShare: "/api/tasks/:taskId/share",
  /** POST：加入 Task 成員。 */
  taskShareMembers: "/api/tasks/:taskId/share/members",
  /** PATCH／DELETE：改變成員的角色（含轉移擁有者）或移除。 */
  taskShareMember: "/api/tasks/:taskId/share/members/:memberId",
  /** PUT：一般存取。 */
  taskShareGeneral: "/api/tasks/:taskId/share/general",
  /** POST：以 email 邀請。 */
  taskShareInvites: "/api/tasks/:taskId/share/invites",
  /** DELETE：撤銷邀請。 */
  taskShareInvite: "/api/tasks/:taskId/share/invites/:inviteId",

  run: "/api/runs/:runId",
  /** 查詢參數：`afterSeq`（不含，預設 0）、`limit`。 */
  runEvents: "/api/runs/:runId/events",
  runCancel: "/api/runs/:runId/cancel",
  runReviewDiff: "/api/runs/:runId/review-diff",
  runPermissionResponse: "/api/runs/:runId/permission-requests/:requestId/response",
  runVerifications: "/api/runs/:runId/verifications",
  /** POST：Verification 超過重試上限後的決定。 */
  runVerificationDecision: "/api/runs/:runId/verification-decision",
  runPreview: "/api/runs/:runId/preview",
  runPreviewRestart: "/api/runs/:runId/preview/restart",
  /** POST（multipart）：上傳 Preview 留言的截圖。 */
  runPreviewScreenshots: "/api/runs/:runId/preview/screenshots",
  /** GET／POST：預覽邀請。 */
  runPreviewInvites: "/api/runs/:runId/preview-invites",
  /** DELETE：撤銷預覽邀請。 */
  runPreviewInvite: "/api/runs/:runId/preview-invites/:inviteId",
  /** POST：執行中傳訊息給 Agent（排隊或中斷）。 */
  runPrompts: "/api/runs/:runId/prompts",
  /** DELETE：收回還在排隊的訊息。 */
  runPrompt: "/api/runs/:runId/prompts/:controlId",
  /** GET／PATCH：執行中的模型、推理強度、Permission Policy。 */
  runSettings: "/api/runs/:runId/settings",
  /** POST：換 Agent 並接續作業。 */
  runSwitchAgent: "/api/runs/:runId/switch-agent",
  /** POST：開互動式終端機。 */
  runTerminals: "/api/runs/:runId/terminals",
  /** GET：換票後 302 到 Preview 子網域（Preview 網址需要登入）。 */
  previewAuthorize: "/api/preview/:runId/authorize",
  /** POST：人回答 Child Run 的 `ask_parent`。 */
  childQuestionAnswer: "/api/child-questions/:questionId/answer",

  gateDecision: "/api/gates/:gateId/decision",
  needsYou: "/api/needs-you",

  notifications: "/api/notifications",
  notificationsUnreadCount: "/api/notifications/unread-count",
  notificationsRead: "/api/notifications/read",
  /** GET：Electron 輪詢的桌面通知 feed。 */
  notificationsDesktopFeed: "/api/notifications/desktop-feed",
  /** GET／PUT：個人的通知設定。 */
  notificationPreferences: "/api/notification-preferences",

  /** GET：Member 以上可以看。 */
  credentials: "/api/credentials",
  /** PATCH：覆寫 Credential 的並行上限（Admin 以上）。 */
  runnerCredential: "/api/runners/:runnerId/credentials/:credential",
  /** GET：Member 以上可以看。 */
  teamRunnerQueue: "/api/team-runner-queue",

  /** GET：模型目錄（目前 Member 可用的 Runner 上的 Agent 與 model）。 */
  agentCatalog: "/api/agent-catalog",

  runners: "/api/runners",
  runner: "/api/runners/:runnerId",
  pairingTokens: "/api/runner-pairing-tokens",

  blob: "/api/blobs/:blobId",

  /** GitHub App 的 webhook（由 packages/github 處理）。 */
  githubWebhook: "/api/webhooks/github",
  repoImportableIssues: "/api/repos/:repoId/importable-issues",
  repoImportIssues: "/api/repos/:repoId/import-issues",

  /** Web 的即時推送（訊息見 `ws.ts`）。 */
  ws: "/api/ws",
  /** 共同編輯（y-websocket 協定，文件名稱見 `collab.ts`）。 */
  collab: "/api/collab/:docName",
  /** 互動式終端機的 WebSocket（訊息見 `terminal.ts`）。 */
  terminalWs: "/api/terminals/:terminalId/ws",
} as const;

/**
 * Server 處理、但不在 `/api` 之下的瀏覽器導覽路徑（邀請連結）。它們出現在信件與複製的連結中，所以放在
 * Orbis 主網址的短路徑；Server 要在 Web 靜態檔的 SPA fallback 之前註冊。回應是 302，不是 JSON。
 */
export const PAGE_ROUTES = {
  /** 登入後接受 Task 邀請，轉到 Task 的工作區（見 `share.ts`）。 */
  inviteAccept: "/invites/:token",
  /** 預覽邀請的受邀者登入後換票，轉到預覽子網域（見 `preview.ts`）。 */
  previewInviteAccept: "/preview-invites/:token",
  /** 邀請連結失敗時轉到的 Web 頁面，查詢參數 `code` 是 `INVITE_ERROR_CODES` 之一。 */
  inviteError: "/invites/error",
} as const;

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];
export type PageRoute = (typeof PAGE_ROUTES)[keyof typeof PAGE_ROUTES];

/** 從路徑樣式取出參數名稱，例如 `/api/runs/:runId/events` → `"runId"`。 */
export type RouteParams<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
  ? Param | RouteParams<`/${Rest}`>
  : Path extends `${string}:${infer Param}`
    ? Param
    : never;

/**
 * 代入參數，產生實際的路徑。參數值一律經過 `encodeURIComponent`。
 *
 * ```ts
 * apiPath(API_ROUTES.taskByKey, { taskKey: "ORB-12" }) // "/api/tasks/by-key/ORB-12"
 * ```
 */
export function apiPath<Path extends ApiRoute | PageRoute>(
  path: Path,
  ...[params]: [RouteParams<Path>] extends [never]
    ? []
    : [params: Record<RouteParams<Path>, string>]
): string {
  if (!params) return path;
  const values = params as Record<string, string>;
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`缺少路徑參數 ${name}`);
    return encodeURIComponent(value);
  });
}
