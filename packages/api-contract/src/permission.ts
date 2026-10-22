// 回覆 Agent 的權限請求（ARCHITECTURE §8）。
//
// 路徑：`API_ROUTES.runPermissionResponse`（Run 與權限請求的 ID 都在路徑中），
// Run 即時檢視與 Needs You 都直接呼叫。授權由 Server 檢查：
// - Local Runner 上的 Run：只有該 Runner 的擁有者能回覆。
// - Team Runner 上的 Run：Project 中有效 Role 至少是 Member 的人。
// - `purpose = config_trust`（設定的信任核准）：Admin 以上。

import { z } from "zod";

export const PermissionResponseInput = z
  .object({
    /** 權限請求 Event 中某個選項的 `option_id`。 */
    optionId: z.string().min(1),
  })
  .strict();
export type PermissionResponseInput = z.infer<typeof PermissionResponseInput>;
