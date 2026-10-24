// 工作區用到、後端還沒有的 API（暫定路徑見 types.ts）。真實模式下由 feature flag 關閉，不會呼叫。

import { queryOptions } from "@tanstack/react-query";
import { apiRequest, apiSend } from "../../api/client";
import {
  DRAFT_ROUTES,
  draftPath,
  RunEventActors,
  RunSettings,
  TaskPullRequest,
  type UpdateRunSettingsInput,
} from "./types";

export const workspaceKeys = {
  runSettings: (runId: string) => ["runs", runId, "settings"] as const,
  eventActors: (runId: string) => ["runs", runId, "event-actors"] as const,
  pullRequest: (taskId: string) => ["tasks", taskId, "pull-request"] as const,
};

/** TODO(backend, run-prompt)：執行中傳訊息給 Agent。 */
export function submitRunPrompt(runId: string, text: string): Promise<void> {
  return apiSend(draftPath(DRAFT_ROUTES.runPrompts, { runId }), {
    method: "POST",
    body: { text },
  });
}

/** TODO(backend, run-settings)：目前的推理強度與切換紀錄。 */
export const runSettingsQuery = (runId: string) =>
  queryOptions({
    queryKey: workspaceKeys.runSettings(runId),
    queryFn: ({ signal }) =>
      apiRequest(draftPath(DRAFT_ROUTES.runSettings, { runId }), RunSettings, { signal }),
  });

/** TODO(backend, run-settings)：執行中切換模型、推理強度、權限策略。 */
export function updateRunSettings(
  runId: string,
  input: UpdateRunSettingsInput,
): Promise<RunSettings> {
  return apiRequest(draftPath(DRAFT_ROUTES.runSettings, { runId }), RunSettings, {
    method: "PATCH",
    body: input,
  });
}

/** TODO(backend, event-actor)：prompt 是誰送的、權限請求是誰回覆的。 */
export const eventActorsQuery = (runId: string) =>
  queryOptions({
    queryKey: workspaceKeys.eventActors(runId),
    queryFn: ({ signal }) =>
      apiRequest(draftPath(DRAFT_ROUTES.runEventActors, { runId }), RunEventActors, { signal }),
  });

/** TODO(backend, task-pull-request)：Task 的 PR；還沒開 PR 時為 null。 */
export const taskPullRequestQuery = (taskId: string) =>
  queryOptions({
    queryKey: workspaceKeys.pullRequest(taskId),
    queryFn: ({ signal }) =>
      apiRequest(draftPath(DRAFT_ROUTES.taskPullRequest, { taskId }), TaskPullRequest.nullable(), {
        signal,
      }),
  });
