// REST 錯誤回應的共同格式。

import { z } from "zod";

/**
 * 4xx／5xx 的回應 body。`error` 是給程式判斷的代碼（例如 `forbidden`、`invalid_transition`），
 * `message` 是給人看的說明。
 */
export const ApiError = z.object({
  error: z.string().min(1),
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;
