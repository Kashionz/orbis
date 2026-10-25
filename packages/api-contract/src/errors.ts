// REST 錯誤回應的共同格式。

import { z } from "zod";

/** Task 進入 Ready 的條件：已指定 Repo、描述不為空或有連結的 Spec、至少一條 Acceptance Criterion。 */
export const READY_REQUIREMENTS = ["repo", "description", "acceptance_criteria"] as const;

/**
 * 新工作區介面後端缺口（API 版本 2）新增的錯誤代碼（`ApiError.error`）。Server 與 Web 共用這份清單；
 * 既有的代碼（`forbidden`、`invalid_transition` 等）不在這裡。
 */
export const API_ERROR_CODES = [
  /** 409：Run 已結束。 */
  "run_finished",
  /**
   * 409：Run 目前不接受執行中的訊息（`queued`、`dispatched`、`verifying`、`awaiting_gate`）。
   * Gate 等待時要用 Gate 的 API 退回。
   */
  "run_not_accepting_prompts",
  /** 409：要收回的訊息已經交給 Agent。 */
  "prompt_already_submitted",
  /** 422：這個 Agent 不支援要切換的模型或推理強度。 */
  "option_unsupported",
  /** 422：要換的 Agent 在這個 Run 的 Runner 上不可用。 */
  "agent_unavailable",
  /** 409：Task 已經指定 Repo，不能更換。 */
  "repo_already_set",
  /** 409：沒有指定 Repo 的 Task 不能移到就緒、不能派工。 */
  "repo_required",
  /** 409：GitHub App 沒有安裝在要連接的 repo 上（附 `installUrl`）。 */
  "repo_not_connected",
  /** 409：同一個 Project 已經登記了這個 repo。 */
  "repo_exists",
  /** 409：Worktree 已封存。 */
  "worktree_archived",
  /** 409：這個 Run 已經開了上限數量的終端機。 */
  "terminal_limit",
  /** 403：Team 設定沒有打開 Team Runner 的終端機。 */
  "terminal_disabled",
  /** 409：需要 Runner 在線上（終端機、本機 Repo 的 Spec 提交）。 */
  "runner_offline",
  /** 403：Team 設定沒有打開對外分享預覽。 */
  "preview_sharing_disabled",
  /** 404：邀請不存在。 */
  "invite_not_found",
  /** 410：邀請已過期。 */
  "invite_expired",
  /** 410：邀請已撤銷。 */
  "invite_revoked",
  /** 403：登入者已驗證的 email（或 GitHub 帳號）不是受邀的對象。 */
  "invite_email_mismatch",
] as const;
export const ApiErrorCode = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/**
 * 4xx／5xx 的回應 body。`error` 是給程式判斷的代碼（例如 `forbidden`、`invalid_transition`），
 * `message` 是給人看的說明。
 */
export const ApiError = z.object({
  error: z.string().min(1),
  message: z.string(),
  /** 輸入驗證失敗時，各欄位的問題（zod 的 issues）。 */
  issues: z
    .array(
      z.object({
        /** 欄位路徑，例如 `["policy", "defaultPermissionPolicy"]`。 */
        path: z.array(z.union([z.string(), z.number()])),
        message: z.string(),
      }),
    )
    .optional(),
  /** Task 進入 Ready 的條件不足時缺少的項目（ARCHITECTURE §5），Web 據此提示使用者。 */
  missing: z.array(z.enum(READY_REQUIREMENTS)).optional(),
  /** `repo_not_connected` 時，給使用者安裝 GitHub App 的網址。 */
  installUrl: z.url().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
