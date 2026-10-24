// 工作區用到、後端還沒有的 API 的暫定型別（不是契約；協調者彙整成後端開發規劃後再進 @orbis/api-contract）。
// 每一個都對應一個 `TODO(backend, <代號>)`，資料形狀以設計的 README「State Management」為準。

import { PermissionPolicy, PullRequestState } from "@orbis/api-contract";
import { z } from "zod";

/** 暫定的路徑；`:name` 由 `draftPath()` 代入。 */
export const DRAFT_ROUTES = {
  /** TODO(backend, run-prompt)：`POST` 執行中傳訊息給 Agent（RunControl `prompt`，source `user`）。 */
  runPrompts: "/api/runs/:runId/prompts",
  /** TODO(backend, run-settings)：`GET`／`PATCH` 執行中切換模型、推理強度、權限策略。 */
  runSettings: "/api/runs/:runId/settings",
  /** TODO(backend, event-actor)：`GET` prompt 是誰送的、權限請求是誰回覆的。 */
  runEventActors: "/api/runs/:runId/event-actors",
  /** TODO(backend, task-pull-request)：`GET` Task 的 PR（號碼、網址、狀態）。 */
  taskPullRequest: "/api/tasks/:taskId/pull-request",
} as const;

/** 代入路徑參數（參數值經過 `encodeURIComponent`）。 */
export function draftPath(path: string, params: Record<string, string>): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`缺少路徑參數 ${name}`);
    return encodeURIComponent(value);
  });
}

/** 推理強度（README：fast｜std｜deep）。 */
export const RUN_EFFORTS = ["fast", "std", "deep"] as const;
export const RunEffort = z.enum(RUN_EFFORTS);
export type RunEffort = z.infer<typeof RunEffort>;

/** 執行中傳給 Agent 的訊息。 */
export const RunPromptInput = z.object({ text: z.string().trim().min(1) }).strict();
export type RunPromptInput = z.infer<typeof RunPromptInput>;

/** 執行中切換設定的一筆紀錄（事件串流顯示成系統事件）。 */
export const RunSettingsChange = z.object({
  ts: z.string(),
  /** 切換的 Member；系統自動切換時為 null。 */
  memberId: z.string().nullable(),
  kind: z.enum(["model", "effort", "policy"]),
  agent: z.string().nullable(),
  model: z.string().nullable(),
  effort: RunEffort.nullable(),
  permissionPolicy: PermissionPolicy.nullable(),
});
export type RunSettingsChange = z.infer<typeof RunSettingsChange>;

export const RunSettings = z.object({
  /** 目前的推理強度；模型不支援調整時為 null。 */
  effort: RunEffort.nullable(),
  changes: z.array(RunSettingsChange),
});
export type RunSettings = z.infer<typeof RunSettings>;

/** 切換設定：只送要改的欄位，至少一個。換 Agent 時 `model` 必須同時給。 */
export const UpdateRunSettingsInput = z
  .object({
    agent: z.string().min(1),
    model: z.string().min(1),
    effort: RunEffort,
    permissionPolicy: PermissionPolicy,
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, { error: "至少要改一個設定" });
export type UpdateRunSettingsInput = z.input<typeof UpdateRunSettingsInput>;

/** 事件的作者：`prompts` 以 seq 為 key、`permissions` 以 request id 為 key，值是 Member id。 */
export const RunEventActors = z.object({
  prompts: z.record(z.string(), z.string()),
  permissions: z.record(z.string(), z.string()),
});
export type RunEventActors = z.infer<typeof RunEventActors>;

export const TaskPullRequest = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  state: PullRequestState,
  /** 開出 PR 的 Run。 */
  runId: z.string().nullable(),
  openedAt: z.string(),
  mergedAt: z.string().nullable(),
});
export type TaskPullRequest = z.infer<typeof TaskPullRequest>;
