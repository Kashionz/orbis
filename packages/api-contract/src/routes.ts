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

  task: "/api/tasks/:taskId",
  taskByKey: "/api/tasks/by-key/:taskKey",
  taskTransition: "/api/tasks/:taskId/transition",
  taskAcceptanceCriteria: "/api/tasks/:taskId/acceptance-criteria",
  acceptanceCriterion: "/api/acceptance-criteria/:criterionId",
  taskRuns: "/api/tasks/:taskId/runs",
  taskGates: "/api/tasks/:taskId/gates",

  run: "/api/runs/:runId",
  /** 查詢參數：`afterSeq`（不含，預設 0）、`limit`。 */
  runEvents: "/api/runs/:runId/events",
  runCancel: "/api/runs/:runId/cancel",
  runReviewDiff: "/api/runs/:runId/review-diff",
  runPermissionResponse: "/api/runs/:runId/permission-requests/:requestId/response",

  gateDecision: "/api/gates/:gateId/decision",
  needsYou: "/api/needs-you",

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
