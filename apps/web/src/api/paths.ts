// Server REST 與 WebSocket 的路徑。
//
// TODO(api): 這是 C1 依需求列出的暫時清單，協調者會和 B1 的端點對齊後放進 contract/web-api；
// 對齊後依契約修改這裡，MSW 假後端（src/mocks）也跟著改。

const segment = encodeURIComponent;

export const API_PATHS = {
  projects: "/api/projects",
  projectRepos: (projectId: string) => `/api/projects/${segment(projectId)}/repos`,
  projectTasks: (projectId: string) => `/api/projects/${segment(projectId)}/tasks`,
  task: (taskId: string) => `/api/tasks/${segment(taskId)}`,
  taskByKey: (taskKey: string) => `/api/tasks/by-key/${segment(taskKey)}`,
  taskTransition: (taskId: string) => `/api/tasks/${segment(taskId)}/transition`,
  taskAcceptanceCriteria: (taskId: string) => `/api/tasks/${segment(taskId)}/acceptance-criteria`,
  acceptanceCriterion: (id: string) => `/api/acceptance-criteria/${segment(id)}`,
  taskRuns: (taskId: string) => `/api/tasks/${segment(taskId)}/runs`,
  run: (runId: string) => `/api/runs/${segment(runId)}`,
  runEvents: (runId: string, afterSeq: number, limit: number) =>
    `/api/runs/${segment(runId)}/events?afterSeq=${afterSeq}&limit=${limit}`,
  runPermissionResponses: (runId: string) => `/api/runs/${segment(runId)}/permission-responses`,
  runReviewDiff: (runId: string) => `/api/runs/${segment(runId)}/review-diff`,
  runReview: (runId: string) => `/api/runs/${segment(runId)}/review`,
  runCancel: (runId: string) => `/api/runs/${segment(runId)}/cancel`,
  members: "/api/members",
  dispatchOptions: "/api/dispatch-options",
  needsYou: "/api/needs-you",
  blob: (blobId: string) => `/api/blobs/${segment(blobId)}`,
  /** Run Event 的 WebSocket（frame 見 schemas.ts 的 ClientFrame／ServerFrame）。 */
  eventsSocket: "/api/ws",
} as const;
