// REST 錯誤回應的共同格式。

import { z } from "zod";

/** Task 進入 Ready 的條件：已指定 Repo、描述不為空或有連結的 Spec、至少一條 Acceptance Criterion。 */
export const READY_REQUIREMENTS = ["repo", "description", "acceptance_criteria"] as const;

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
});
export type ApiError = z.infer<typeof ApiError>;
