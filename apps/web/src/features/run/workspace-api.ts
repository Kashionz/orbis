// 工作區的 Run 操作：執行中傳訊息與收回、Run 的設定（模型、推理強度、權限策略）與換 Agent、互動式終端機、
// 本機合併的重試。
import {
  AgentSwitchRequested,
  API_ROUTES,
  apiPath,
  type CreateRunPromptInput,
  type CreateTerminalInput,
  LocalMergeRetryRequested,
  RunPromptCreated,
  RunSettings,
  RunSettingsUpdated,
  type SwitchAgentInput,
  TerminalCreated,
  type UpdateRunSettingsInput,
} from "@orbis/api-contract";
import { queryOptions } from "@tanstack/react-query";
import { apiRequest, apiSend } from "../../api/client";

export const workspaceKeys = {
  runSettings: (runId: string) => ["runs", runId, "settings"] as const,
};

/** 執行中傳訊息給 Agent：回合中排隊（`queue`），或中斷目前的回合後送出（`interrupt`）。 */
export function submitRunPrompt(runId: string, input: CreateRunPromptInput) {
  return apiRequest(apiPath(API_ROUTES.runPrompts, { runId }), RunPromptCreated, {
    method: "POST",
    body: input,
  });
}

/** 收回還在排隊的訊息。結果以 `prompt_withdrawn`／`prompt_submitted` Event 為準。 */
export function withdrawRunPrompt(runId: string, controlId: string): Promise<void> {
  return apiSend(apiPath(API_ROUTES.runPrompt, { runId, controlId }), { method: "DELETE" });
}

/** 派工時的設定、目前的設定與切換紀錄。 */
export const runSettingsQuery = (runId: string) =>
  queryOptions({
    queryKey: workspaceKeys.runSettings(runId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.runSettings, { runId }), RunSettings, { signal }),
  });

/** 切換模型、推理強度、權限策略（回 202，生效時 Runner 送 Event）。 */
export function updateRunSettings(runId: string, input: UpdateRunSettingsInput) {
  return apiRequest(apiPath(API_ROUTES.runSettings, { runId }), RunSettingsUpdated, {
    method: "PATCH",
    body: input,
  });
}

/** 換成同一台 Runner 上的另一個 Agent（回合中送出時等回合結束才換）。 */
export function switchRunAgent(runId: string, input: SwitchAgentInput) {
  return apiRequest(apiPath(API_ROUTES.runSwitchAgent, { runId }), AgentSwitchRequested, {
    method: "POST",
    body: input,
  });
}

/** 開一個互動式終端機，回傳 WebSocket 的路徑。 */
export function openRunTerminal(runId: string, input: CreateTerminalInput) {
  return apiRequest(apiPath(API_ROUTES.runTerminals, { runId }), TerminalCreated, {
    method: "POST",
    body: input,
  });
}

/** 本機合併被擋下後重試（ADR-0013）。 */
export function retryLocalMerge(runId: string) {
  return apiRequest(apiPath(API_ROUTES.runMergeLocal, { runId }), LocalMergeRetryRequested, {
    method: "POST",
  });
}
