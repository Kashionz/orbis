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
  projectDispatchOptions: "/api/projects/:projectId/dispatch-options",

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
  /** POST：重新讀取 Repo 的 GitHub App 安裝狀態。 */
  repoRefreshInstallation: "/api/repos/:repoId/github/refresh",
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

  credentials: "/api/credentials",
  /** PATCH：覆寫 Credential 的並行上限（Admin 以上）。 */
  runnerCredential: "/api/runners/:runnerId/credentials/:credential",
  teamRunnerQueue: "/api/team-runner-queue",

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
} as const;

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];

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
export function apiPath<Path extends ApiRoute>(
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
