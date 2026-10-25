// 各資源的讀取（TanStack Query 的 queryOptions）與寫入函式。

import {
  AcceptanceCriterion,
  type AddMemberInput,
  type AnswerChildQuestionInput,
  API_ROUTES,
  apiPath,
  ConfirmDraftTasksResponse,
  type CreateAcceptanceCriterionInput,
  type CreateProjectInput,
  type CreateRepoInput,
  type CreateRepoSpecInput,
  type CreateRunInput,
  type CreateTaskInput,
  CredentialListResponse,
  DispatchOptions,
  DraftTask,
  DraftTaskListResponse,
  Gate,
  type GateDecisionInput,
  type MarkNotificationsReadInput,
  Member,
  MentionCandidates,
  MentionListResponse,
  NeedsYouListResponse,
  NotificationListResponse,
  NotificationPreferences,
  NotificationUnreadCount,
  PairingTokenCreated,
  type PermissionResponseInput,
  Project,
  ProjectMemberRole,
  Repo,
  RepoSpec,
  type RepoSpecCommitInput,
  RepoSpecCommitResponse,
  RepoSpecListResponse,
  ReviewDiff,
  type Role,
  Run,
  RunEvent,
  Runner,
  type RunnerKind,
  Task,
  TaskComment,
  TaskCommentListResponse,
  TaskNoteListResponse,
  type TaskStatus,
  Team,
  TeamRunnerQueueResponse,
  type UpdateAcceptanceCriterionInput,
  type UpdateDraftTaskInput,
  type UpdateProjectInput,
  type UpdateRunnerCredentialInput,
  type UpdateTaskInput,
  type UpdateTeamInput,
  type VerificationDecisionInput,
  VerificationListResponse,
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
  dispatchOptions: (projectId: string, taskId?: string) =>
    ["projects", projectId, "dispatch-options", taskId ?? null] as const,
  needsYou: ["needs-you"] as const,
  verifications: (runId: string) => ["runs", runId, "verifications"] as const,
  draftTasks: (projectId: string) => ["projects", projectId, "draft-tasks"] as const,
  mentionCandidates: (projectId: string) => ["projects", projectId, "mention-candidates"] as const,
  projectRoles: (projectId: string) => ["projects", projectId, "roles"] as const,
  taskComments: (taskId: string) => ["tasks", taskId, "comments"] as const,
  taskNotes: (taskId: string) => ["tasks", taskId, "notes"] as const,
  taskMentions: (taskId: string) => ["tasks", taskId, "mentions"] as const,
  notifications: ["notifications", "list"] as const,
  notificationsUnreadCount: ["notifications", "unread-count"] as const,
  notificationPreferences: ["notification-preferences"] as const,
  credentials: ["credentials"] as const,
  teamRunnerQueue: ["team-runner-queue"] as const,
  runners: ["runners"] as const,
  repoSpecs: (repoId: string) => ["repos", repoId, "specs"] as const,
  repoSpec: (repoSpecId: string) => ["repo-specs", repoSpecId] as const,
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

/**
 * 派工對話框的選項。帶 `taskId` 時依那個 Task 判斷：本機 Repo 只能派到有對應的 Local Runner
 * （沒有對應時 `unavailableReason` 為 `repo_not_mapped`，Team Runner 為 null）。
 */
export const dispatchOptionsQuery = (projectId: string, taskId?: string) =>
  queryOptions({
    queryKey: queryKeys.dispatchOptions(projectId, taskId),
    queryFn: ({ signal }) =>
      apiRequest(
        `${apiPath(API_ROUTES.projectDispatchOptions, { projectId })}${
          taskId ? `?taskId=${encodeURIComponent(taskId)}` : ""
        }`,
        DispatchOptions,
        { signal },
      ),
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

/** 一筆 Run 的 Event（例如 Plan Gate 送審的 `plan_proposed`，以 `Gate.planSeq` 取得）。 */
export const runEventQuery = (runId: string, seq: number) =>
  queryOptions({
    queryKey: ["runs", runId, "events", seq] as const,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ afterSeq: String(seq - 1), limit: "1" });
      const events = await apiRequest(
        `${apiPath(API_ROUTES.runEvents, { runId })}?${query}`,
        z.array(RunEvent),
        { signal },
      );
      const found = events.find((e) => e.seq === seq);
      if (!found) throw new Error(`找不到 Run 的第 ${seq} 筆 Event`);
      return found;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

// ---------- Verification 與 `manual` 打勾（ARCHITECTURE §5.1） ----------

export const verificationsQuery = (runId: string) =>
  queryOptions({
    queryKey: queryKeys.verifications(runId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.runVerifications, { runId }), VerificationListResponse, {
        signal,
      }),
  });

export function decideVerification(runId: string, input: VerificationDecisionInput): Promise<void> {
  return apiSend(apiPath(API_ROUTES.runVerificationDecision, { runId }), {
    method: "POST",
    body: input,
  });
}

export function checkAcceptanceCriterion(
  criterionId: string,
  checked: boolean,
): Promise<AcceptanceCriterion> {
  return apiRequest(
    apiPath(API_ROUTES.acceptanceCriterionCheck, { criterionId }),
    AcceptanceCriterion,
    { method: "POST", body: { checked } },
  );
}

// ---------- Repo 與 Repo Spec（ARCHITECTURE §11、§12.1） ----------

export function refreshRepoInstallation(repoId: string): Promise<Repo> {
  return apiRequest(apiPath(API_ROUTES.repoRefreshInstallation, { repoId }), Repo, {
    method: "POST",
  });
}

/** 本機 Repo 改成 GitHub Repo（只能單向，ADR-0013）。 */
export function connectRepoToGithub(
  repoId: string,
  input: { owner: string; name: string },
): Promise<Repo> {
  return apiRequest(apiPath(API_ROUTES.repoConnectGithub, { repoId }), Repo, {
    method: "POST",
    body: input,
  });
}

export function deleteRepo(repoId: string): Promise<void> {
  return apiSend(apiPath(API_ROUTES.repo, { repoId }), { method: "DELETE" });
}

export const repoSpecsQuery = (repoId: string) =>
  queryOptions({
    queryKey: queryKeys.repoSpecs(repoId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.repoSpecs, { repoId }), RepoSpecListResponse, { signal }),
  });

export const repoSpecQuery = (repoSpecId: string) =>
  queryOptions({
    queryKey: queryKeys.repoSpec(repoSpecId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.repoSpec, { repoSpecId }), RepoSpec, { signal }),
  });

export function createRepoSpec(repoId: string, input: CreateRepoSpecInput): Promise<RepoSpec> {
  return apiRequest(apiPath(API_ROUTES.repoSpecs, { repoId }), RepoSpec, {
    method: "POST",
    body: input,
  });
}

export function commitRepoSpec(
  repoSpecId: string,
  input: RepoSpecCommitInput,
): Promise<RepoSpecCommitResponse> {
  return apiRequest(apiPath(API_ROUTES.repoSpecCommit, { repoSpecId }), RepoSpecCommitResponse, {
    method: "POST",
    body: input,
  });
}

// ---------- Draft Task 與 Child Run 的問題（ARCHITECTURE §9） ----------

export const draftTasksQuery = (projectId: string) =>
  queryOptions({
    queryKey: queryKeys.draftTasks(projectId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.projectDraftTasks, { projectId }), DraftTaskListResponse, {
        signal,
      }),
    refetchInterval: POLL_INTERVAL_MS,
  });

export function updateDraftTask(draftTaskId: string, input: UpdateDraftTaskInput) {
  return apiRequest(apiPath(API_ROUTES.draftTask, { draftTaskId }), DraftTask, {
    method: "PATCH",
    body: input,
  });
}

export function confirmDraftTask(draftTaskId: string): Promise<Task> {
  return apiRequest(apiPath(API_ROUTES.draftTaskConfirm, { draftTaskId }), Task, {
    method: "POST",
  });
}

export function dismissDraftTask(draftTaskId: string): Promise<void> {
  return apiSend(apiPath(API_ROUTES.draftTaskDismiss, { draftTaskId }), { method: "POST" });
}

export function confirmDraftTasks(projectId: string, draftTaskIds: string[]) {
  return apiRequest(
    apiPath(API_ROUTES.projectDraftTasksConfirm, { projectId }),
    ConfirmDraftTasksResponse,
    { method: "POST", body: { draftTaskIds } },
  );
}

export function dismissDraftTasks(projectId: string, draftTaskIds: string[]): Promise<void> {
  return apiSend(apiPath(API_ROUTES.projectDraftTasksDismiss, { projectId }), {
    method: "POST",
    body: { draftTaskIds },
  });
}

export function answerChildQuestion(
  questionId: string,
  input: AnswerChildQuestionInput,
): Promise<void> {
  return apiSend(apiPath(API_ROUTES.childQuestionAnswer, { questionId }), {
    method: "POST",
    body: input,
  });
}

// ---------- 留言、Task note 與 @mention（ARCHITECTURE §12.3） ----------

export const taskCommentsQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.taskComments(taskId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.taskComments, { taskId }), TaskCommentListResponse, {
        signal,
      }),
    refetchInterval: POLL_INTERVAL_MS,
  });

export function createTaskComment(taskId: string, body: string): Promise<TaskComment> {
  return apiRequest(apiPath(API_ROUTES.taskComments, { taskId }), TaskComment, {
    method: "POST",
    body: { body },
  });
}

export function updateTaskComment(commentId: string, body: string): Promise<TaskComment> {
  return apiRequest(apiPath(API_ROUTES.taskComment, { commentId }), TaskComment, {
    method: "PATCH",
    body: { body },
  });
}

export function deleteTaskComment(commentId: string): Promise<void> {
  return apiSend(apiPath(API_ROUTES.taskComment, { commentId }), { method: "DELETE" });
}

export const taskNotesQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.taskNotes(taskId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.taskNotes, { taskId }), TaskNoteListResponse, { signal }),
  });

export const taskMentionsQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.taskMentions(taskId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.taskMentions, { taskId }), MentionListResponse, { signal }),
    refetchInterval: POLL_INTERVAL_MS,
  });

export const mentionCandidatesQuery = (projectId: string) =>
  queryOptions({
    queryKey: queryKeys.mentionCandidates(projectId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.projectMentionCandidates, { projectId }), MentionCandidates, {
        signal,
      }),
    staleTime: 60_000,
  });

// ---------- 通知（ARCHITECTURE §12.3） ----------

/** 通知列表的一頁（新的在前）。`before` 是上一頁回傳的 `nextBefore`。 */
export function fetchNotifications(
  unreadOnly: boolean,
  before: string | null,
  signal?: AbortSignal,
): Promise<NotificationListResponse> {
  const query = new URLSearchParams({ limit: "50" });
  if (unreadOnly) query.set("unreadOnly", "true");
  if (before) query.set("before", before);
  return apiRequest(`${API_ROUTES.notifications}?${query}`, NotificationListResponse, { signal });
}

export const notificationsUnreadCountQuery = queryOptions({
  queryKey: queryKeys.notificationsUnreadCount,
  queryFn: ({ signal }) =>
    apiRequest(API_ROUTES.notificationsUnreadCount, NotificationUnreadCount, { signal }),
});

export function markNotificationsRead(input: MarkNotificationsReadInput): Promise<void> {
  return apiSend(API_ROUTES.notificationsRead, { method: "POST", body: input });
}

export const notificationPreferencesQuery = queryOptions({
  queryKey: queryKeys.notificationPreferences,
  queryFn: ({ signal }) =>
    apiRequest(API_ROUTES.notificationPreferences, NotificationPreferences, { signal }),
});

export function updateNotificationPreferences(
  input: NotificationPreferences,
): Promise<NotificationPreferences> {
  return apiRequest(API_ROUTES.notificationPreferences, NotificationPreferences, {
    method: "PUT",
    body: input,
  });
}

// ---------- Credential、佇列與 Runner（ARCHITECTURE §6.1、§7） ----------

export const credentialsQuery = queryOptions({
  queryKey: queryKeys.credentials,
  queryFn: ({ signal }) => apiRequest(API_ROUTES.credentials, CredentialListResponse, { signal }),
  refetchInterval: POLL_INTERVAL_MS,
});

export function updateRunnerCredential(
  runnerId: string,
  credential: string,
  input: UpdateRunnerCredentialInput,
): Promise<void> {
  return apiSend(apiPath(API_ROUTES.runnerCredential, { runnerId, credential }), {
    method: "PATCH",
    body: input,
  });
}

export const teamRunnerQueueQuery = queryOptions({
  queryKey: queryKeys.teamRunnerQueue,
  queryFn: ({ signal }) =>
    apiRequest(API_ROUTES.teamRunnerQueue, TeamRunnerQueueResponse, { signal }),
  refetchInterval: POLL_INTERVAL_MS,
});

export const runnersQuery = queryOptions({
  queryKey: queryKeys.runners,
  queryFn: ({ signal }) => apiRequest(API_ROUTES.runners, z.array(Runner), { signal }),
  refetchInterval: POLL_INTERVAL_MS,
});

export function createPairingToken(kind: RunnerKind): Promise<PairingTokenCreated> {
  return apiRequest(API_ROUTES.pairingTokens, PairingTokenCreated, {
    method: "POST",
    body: { kind },
  });
}

// ---------- 成員與 Role（ARCHITECTURE §12.2） ----------

export function addMember(input: AddMemberInput): Promise<Member> {
  return apiRequest(API_ROUTES.members, Member, { method: "POST", body: input });
}

export function updateMemberRole(memberId: string, role: Role): Promise<Member> {
  return apiRequest(apiPath(API_ROUTES.member, { memberId }), Member, {
    method: "PATCH",
    body: { role },
  });
}

export function removeMember(memberId: string): Promise<void> {
  return apiSend(apiPath(API_ROUTES.member, { memberId }), { method: "DELETE" });
}

export const projectRolesQuery = (projectId: string) =>
  queryOptions({
    queryKey: queryKeys.projectRoles(projectId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.projectRoles, { projectId }), z.array(ProjectMemberRole), {
        signal,
      }),
  });

export function setProjectRole(
  projectId: string,
  memberId: string,
  role: ProjectMemberRole["role"],
): Promise<ProjectMemberRole> {
  return apiRequest(apiPath(API_ROUTES.projectRole, { projectId, memberId }), ProjectMemberRole, {
    method: "PUT",
    body: { role },
  });
}

export function deleteProjectRole(projectId: string, memberId: string): Promise<void> {
  return apiSend(apiPath(API_ROUTES.projectRole, { projectId, memberId }), { method: "DELETE" });
}

// ---------- Team（設定→帳號） ----------

/** Team（名稱與兩個分享設定：對外分享預覽、Team Runner 的終端機）。 */
export const teamQuery = queryOptions({
  queryKey: ["team"] as const,
  queryFn: ({ signal }) => apiRequest(API_ROUTES.team, Team, { signal }),
});

/** 修改 Team 的設定（Admin 以上，只送要改的欄位）。 */
export function updateTeamSettings(input: UpdateTeamInput): Promise<Team> {
  return apiRequest(API_ROUTES.team, Team, { method: "PATCH", body: input });
}

export function updateTeam(name: string): Promise<Team> {
  return apiRequest(API_ROUTES.team, Team, { method: "PATCH", body: { name } });
}
