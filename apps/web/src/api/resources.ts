// 各資源的讀取（TanStack Query 的 queryOptions）與寫入函式。

import {
  AcceptanceCriterion,
  type CreateAcceptanceCriterionInput,
  type CreateTaskInput,
  NeedsYouItem,
  Project,
  Repo,
  Run,
  Task,
  type TaskStatus,
  type UpdateAcceptanceCriterionInput,
  type UpdateTaskInput,
} from "@orbis/api-contract";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest, apiSend } from "./client";
import { API_PATHS } from "./paths";
import {
  type CreateRunInput,
  DispatchOptions,
  Member,
  type PermissionResponseInput,
  type ReviewDecisionInput,
  ReviewDiff,
} from "./schemas";

/** 看板與 Needs You 的輪詢間隔（使用者決定：5 秒輪詢，自己的操作後立即重新取得）。 */
export const POLL_INTERVAL_MS = 5_000;

export const queryKeys = {
  projects: ["projects"] as const,
  repos: (projectId: string) => ["projects", projectId, "repos"] as const,
  tasks: (projectId: string) => ["projects", projectId, "tasks"] as const,
  task: (taskId: string) => ["tasks", taskId] as const,
  taskByKey: (taskKey: string) => ["tasks", "by-key", taskKey] as const,
  acceptanceCriteria: (taskId: string) => ["tasks", taskId, "acceptance-criteria"] as const,
  taskRuns: (taskId: string) => ["tasks", taskId, "runs"] as const,
  run: (runId: string) => ["runs", runId] as const,
  reviewDiff: (runId: string) => ["runs", runId, "review-diff"] as const,
  members: ["members"] as const,
  dispatchOptions: ["dispatch-options"] as const,
  needsYou: ["needs-you"] as const,
};

export const projectsQuery = queryOptions({
  queryKey: queryKeys.projects,
  queryFn: ({ signal }) => apiRequest(API_PATHS.projects, z.array(Project), { signal }),
});

export const reposQuery = (projectId: string) =>
  queryOptions({
    queryKey: queryKeys.repos(projectId),
    queryFn: ({ signal }) =>
      apiRequest(API_PATHS.projectRepos(projectId), z.array(Repo), { signal }),
  });

export const tasksQuery = (projectId: string) =>
  queryOptions({
    queryKey: queryKeys.tasks(projectId),
    queryFn: ({ signal }) =>
      apiRequest(API_PATHS.projectTasks(projectId), z.array(Task), { signal }),
    refetchInterval: POLL_INTERVAL_MS,
  });

export const taskQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.task(taskId),
    queryFn: ({ signal }) => apiRequest(API_PATHS.task(taskId), Task, { signal }),
  });

export const taskByKeyQuery = (taskKey: string) =>
  queryOptions({
    queryKey: queryKeys.taskByKey(taskKey),
    queryFn: ({ signal }) => apiRequest(API_PATHS.taskByKey(taskKey), Task, { signal }),
    refetchInterval: POLL_INTERVAL_MS,
  });

export const acceptanceCriteriaQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.acceptanceCriteria(taskId),
    queryFn: ({ signal }) =>
      apiRequest(API_PATHS.taskAcceptanceCriteria(taskId), z.array(AcceptanceCriterion), {
        signal,
      }),
  });

export const taskRunsQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.taskRuns(taskId),
    queryFn: ({ signal }) => apiRequest(API_PATHS.taskRuns(taskId), z.array(Run), { signal }),
    refetchInterval: POLL_INTERVAL_MS,
  });

export const runQuery = (runId: string) =>
  queryOptions({
    queryKey: queryKeys.run(runId),
    queryFn: ({ signal }) => apiRequest(API_PATHS.run(runId), Run, { signal }),
  });

export const reviewDiffQuery = (runId: string) =>
  queryOptions({
    queryKey: queryKeys.reviewDiff(runId),
    queryFn: ({ signal }) => apiRequest(API_PATHS.runReviewDiff(runId), ReviewDiff, { signal }),
  });

export const membersQuery = queryOptions({
  queryKey: queryKeys.members,
  queryFn: ({ signal }) => apiRequest(API_PATHS.members, z.array(Member), { signal }),
});

export const dispatchOptionsQuery = queryOptions({
  queryKey: queryKeys.dispatchOptions,
  queryFn: ({ signal }) => apiRequest(API_PATHS.dispatchOptions, DispatchOptions, { signal }),
});

export const needsYouQuery = queryOptions({
  queryKey: queryKeys.needsYou,
  queryFn: ({ signal }) => apiRequest(API_PATHS.needsYou, z.array(NeedsYouItem), { signal }),
  refetchInterval: POLL_INTERVAL_MS,
});

export function createTask(projectId: string, input: CreateTaskInput): Promise<Task> {
  return apiRequest(API_PATHS.projectTasks(projectId), Task, { method: "POST", body: input });
}

export function updateTask(taskId: string, input: UpdateTaskInput): Promise<Task> {
  return apiRequest(API_PATHS.task(taskId), Task, { method: "PATCH", body: input });
}

export function transitionTask(taskId: string, status: TaskStatus): Promise<Task> {
  return apiRequest(API_PATHS.taskTransition(taskId), Task, {
    method: "POST",
    body: { status },
  });
}

export function createAcceptanceCriterion(
  taskId: string,
  input: CreateAcceptanceCriterionInput,
): Promise<AcceptanceCriterion> {
  return apiRequest(API_PATHS.taskAcceptanceCriteria(taskId), AcceptanceCriterion, {
    method: "POST",
    body: input,
  });
}

export function updateAcceptanceCriterion(
  id: string,
  input: UpdateAcceptanceCriterionInput,
): Promise<AcceptanceCriterion> {
  return apiRequest(API_PATHS.acceptanceCriterion(id), AcceptanceCriterion, {
    method: "PATCH",
    body: input,
  });
}

export function deleteAcceptanceCriterion(id: string): Promise<void> {
  return apiSend(API_PATHS.acceptanceCriterion(id), { method: "DELETE" });
}

export function dispatchRun(taskId: string, input: CreateRunInput): Promise<Run> {
  return apiRequest(API_PATHS.taskRuns(taskId), Run, { method: "POST", body: input });
}

export function respondToPermission(runId: string, input: PermissionResponseInput): Promise<void> {
  return apiSend(API_PATHS.runPermissionResponses(runId), { method: "POST", body: input });
}

export function decideReview(runId: string, input: ReviewDecisionInput): Promise<void> {
  return apiSend(API_PATHS.runReview(runId), { method: "POST", body: input });
}

export function cancelRun(runId: string): Promise<void> {
  return apiSend(API_PATHS.runCancel(runId), { method: "POST" });
}
