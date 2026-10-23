// 各資源的讀取（TanStack Query 的 queryOptions）與寫入函式。

import {
  AcceptanceCriterion,
  API_ROUTES,
  apiPath,
  type CreateAcceptanceCriterionInput,
  type CreateProjectInput,
  type CreateRepoInput,
  type CreateRunInput,
  type CreateTaskInput,
  DispatchOptions,
  Gate,
  type GateDecisionInput,
  Member,
  NeedsYouListResponse,
  type PermissionResponseInput,
  Project,
  Repo,
  ReviewDiff,
  Run,
  RunEvent,
  Task,
  type TaskStatus,
  type UpdateAcceptanceCriterionInput,
  type UpdateProjectInput,
  type UpdateTaskInput,
} from "@orbis/api-contract";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest, apiSend, apiText } from "./client";

/** 看板與 Needs You 的輪詢間隔（使用者決定：5 秒輪詢，自己的操作後立即重新取得）。 */
export const POLL_INTERVAL_MS = 5_000;

export const queryKeys = {
  projects: ["projects"] as const,
  project: (projectId: string) => ["projects", projectId] as const,
  repos: (projectId: string) => ["projects", projectId, "repos"] as const,
  tasks: (projectId: string) => ["projects", projectId, "tasks"] as const,
  task: (taskId: string) => ["tasks", taskId] as const,
  taskByKey: (taskKey: string) => ["tasks", "by-key", taskKey] as const,
  acceptanceCriteria: (taskId: string) => ["tasks", taskId, "acceptance-criteria"] as const,
  taskRuns: (taskId: string) => ["tasks", taskId, "runs"] as const,
  run: (runId: string) => ["runs", runId] as const,
  reviewDiff: (runId: string) => ["runs", runId, "review-diff"] as const,
  taskGates: (taskId: string) => ["tasks", taskId, "gates"] as const,
  members: ["members"] as const,
  dispatchOptions: (projectId: string) => ["projects", projectId, "dispatch-options"] as const,
  needsYou: ["needs-you"] as const,
};

export const projectsQuery = queryOptions({
  queryKey: queryKeys.projects,
  queryFn: ({ signal }) => apiRequest(API_ROUTES.projects, z.array(Project), { signal }),
});

export const projectQuery = (projectId: string) =>
  queryOptions({
    queryKey: queryKeys.project(projectId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.project, { projectId }), Project, { signal }),
  });

export const reposQuery = (projectId: string) =>
  queryOptions({
    queryKey: queryKeys.repos(projectId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.projectRepos, { projectId }), z.array(Repo), { signal }),
  });

export const tasksQuery = (projectId: string) =>
  queryOptions({
    queryKey: queryKeys.tasks(projectId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.projectTasks, { projectId }), z.array(Task), { signal }),
    refetchInterval: POLL_INTERVAL_MS,
  });

export const taskQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.task(taskId),
    queryFn: ({ signal }) => apiRequest(apiPath(API_ROUTES.task, { taskId }), Task, { signal }),
  });

export const taskByKeyQuery = (taskKey: string) =>
  queryOptions({
    queryKey: queryKeys.taskByKey(taskKey),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.taskByKey, { taskKey }), Task, { signal }),
    refetchInterval: POLL_INTERVAL_MS,
  });

export const acceptanceCriteriaQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.acceptanceCriteria(taskId),
    queryFn: ({ signal }) =>
      apiRequest(
        apiPath(API_ROUTES.taskAcceptanceCriteria, { taskId }),
        z.array(AcceptanceCriterion),
        {
          signal,
        },
      ),
  });

export const taskRunsQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.taskRuns(taskId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.taskRuns, { taskId }), z.array(Run), { signal }),
    refetchInterval: POLL_INTERVAL_MS,
  });

export const runQuery = (runId: string) =>
  queryOptions({
    queryKey: queryKeys.run(runId),
    queryFn: ({ signal }) => apiRequest(apiPath(API_ROUTES.run, { runId }), Run, { signal }),
  });

export const reviewDiffQuery = (runId: string) =>
  queryOptions({
    queryKey: queryKeys.reviewDiff(runId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.runReviewDiff, { runId }), ReviewDiff, { signal }),
  });

export const membersQuery = queryOptions({
  queryKey: queryKeys.members,
  queryFn: ({ signal }) => apiRequest(API_ROUTES.members, z.array(Member), { signal }),
});

export const dispatchOptionsQuery = (projectId: string) =>
  queryOptions({
    queryKey: queryKeys.dispatchOptions(projectId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.projectDispatchOptions, { projectId }), DispatchOptions, {
        signal,
      }),
  });

export const needsYouQuery = queryOptions({
  queryKey: queryKeys.needsYou,
  queryFn: ({ signal }) => apiRequest(API_ROUTES.needsYou, NeedsYouListResponse, { signal }),
  refetchInterval: POLL_INTERVAL_MS,
});

export const taskGatesQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.taskGates(taskId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.taskGates, { taskId }), z.array(Gate), { signal }),
  });

/** Run 的 Event（seq 大於 `afterSeq`，依 seq 排序），WebSocket 缺號時補抓用。 */
export function fetchRunEvents(runId: string, afterSeq: number, limit: number) {
  const query = new URLSearchParams({ afterSeq: String(afterSeq), limit: String(limit) });
  return apiRequest(`${apiPath(API_ROUTES.runEvents, { runId })}?${query}`, z.array(RunEvent));
}

/** blob 的下載網址（大檔的 diff 內容、tool call 輸出）。 */
export function blobUrl(blobId: string): string {
  return apiPath(API_ROUTES.blob, { blobId });
}

/** blob 的文字內容（diff review 顯示大檔用）。blob 以 ID 定址、內容不變，取得後不再重新取得。 */
export const blobTextQuery = (blobId: string) =>
  queryOptions({
    queryKey: ["blobs", blobId] as const,
    queryFn: ({ signal }) => apiText(blobUrl(blobId), { signal }),
    staleTime: Number.POSITIVE_INFINITY,
  });

export function createProject(input: CreateProjectInput): Promise<Project> {
  return apiRequest(API_ROUTES.projects, Project, { method: "POST", body: input });
}

export function updateProject(projectId: string, input: UpdateProjectInput): Promise<Project> {
  return apiRequest(apiPath(API_ROUTES.project, { projectId }), Project, {
    method: "PATCH",
    body: input,
  });
}

export function createRepo(projectId: string, input: CreateRepoInput): Promise<Repo> {
  return apiRequest(apiPath(API_ROUTES.projectRepos, { projectId }), Repo, {
    method: "POST",
    body: input,
  });
}

export function createTask(projectId: string, input: CreateTaskInput): Promise<Task> {
  return apiRequest(apiPath(API_ROUTES.projectTasks, { projectId }), Task, {
    method: "POST",
    body: input,
  });
}

export function updateTask(taskId: string, input: UpdateTaskInput): Promise<Task> {
  return apiRequest(apiPath(API_ROUTES.task, { taskId }), Task, { method: "PATCH", body: input });
}

export function transitionTask(taskId: string, status: TaskStatus): Promise<Task> {
  return apiRequest(apiPath(API_ROUTES.taskTransition, { taskId }), Task, {
    method: "POST",
    body: { status },
  });
}

export function createAcceptanceCriterion(
  taskId: string,
  input: CreateAcceptanceCriterionInput,
): Promise<AcceptanceCriterion> {
  return apiRequest(apiPath(API_ROUTES.taskAcceptanceCriteria, { taskId }), AcceptanceCriterion, {
    method: "POST",
    body: input,
  });
}

export function updateAcceptanceCriterion(
  id: string,
  input: UpdateAcceptanceCriterionInput,
): Promise<AcceptanceCriterion> {
  return apiRequest(
    apiPath(API_ROUTES.acceptanceCriterion, { criterionId: id }),
    AcceptanceCriterion,
    {
      method: "PATCH",
      body: input,
    },
  );
}

export function deleteAcceptanceCriterion(id: string): Promise<void> {
  return apiSend(apiPath(API_ROUTES.acceptanceCriterion, { criterionId: id }), {
    method: "DELETE",
  });
}

export function dispatchRun(taskId: string, input: CreateRunInput): Promise<Run> {
  return apiRequest(apiPath(API_ROUTES.taskRuns, { taskId }), Run, { method: "POST", body: input });
}

export function respondToPermission(
  runId: string,
  requestId: string,
  input: PermissionResponseInput,
): Promise<void> {
  return apiSend(apiPath(API_ROUTES.runPermissionResponse, { runId, requestId }), {
    method: "POST",
    body: input,
  });
}

export function decideGate(gateId: string, input: GateDecisionInput): Promise<Gate> {
  return apiRequest(apiPath(API_ROUTES.gateDecision, { gateId }), Gate, {
    method: "POST",
    body: input,
  });
}

export function logoutRequest(): Promise<void> {
  return apiSend(API_ROUTES.authLogout, { method: "POST" });
}

export function cancelRun(runId: string): Promise<Run> {
  return apiRequest(apiPath(API_ROUTES.runCancel, { runId }), Run, { method: "POST" });
}
