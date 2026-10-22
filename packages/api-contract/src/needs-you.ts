// Needs You 項目：等待某位 Member 處理的權限請求、待核准的 Gate、停下來的 Run。

import { PERMISSION_OPTION_KINDS } from "@orbis/protocol";
import { z } from "zod";
import { Id, Timestamp } from "./common";
import { GateKind } from "./enums";
import { TaskKey } from "./task";

const NeedsYouBase = z.object({
  id: Id,
  /** 要處理這個項目的 Member。 */
  memberId: Id,
  taskId: Id,
  /** 方便 UI 直接顯示與跳轉，不必另外查 Task。 */
  taskKey: TaskKey,
  runId: Id,
  createdAt: Timestamp,
});

/** Agent 的權限請求，Permission Policy 判定要問人（§8）。Run 會暫停到回覆為止。 */
// 欄位對應 @orbis/protocol 的 `permission_request` Event（request_id、tool_call_id、title、options）。
export const NeedsYouPermissionRequest = NeedsYouBase.extend({
  kind: z.literal("permission_request"),
  /** 權限請求的 ID，回覆時放進 RunControl 的 `permission_response`。 */
  permissionRequestId: Id,
  /** 觸發請求的 tool call；Agent 沒有提供時為 null。 */
  toolCallId: Id.nullable(),
  /** 給人看的說明，例如要執行的指令。 */
  title: z.string(),
  /** 可以選擇的選項；回覆時送出其中一個 `optionId`。 */
  options: z
    .array(
      z.object({
        optionId: z.string().min(1),
        name: z.string(),
        kind: z.enum(PERMISSION_OPTION_KINDS),
      }),
    )
    .min(1),
});
export type NeedsYouPermissionRequest = z.infer<typeof NeedsYouPermissionRequest>;

/** 等待核准的 Plan Gate 或 Review Gate。 */
export const NeedsYouGate = NeedsYouBase.extend({
  kind: z.literal("gate"),
  gateKind: GateKind,
});
export type NeedsYouGate = z.infer<typeof NeedsYouGate>;

/** 停下來等人處理的 Run，例如 Verification 重試超過上限（§5.1）。 */
export const NeedsYouStoppedRun = NeedsYouBase.extend({
  kind: z.literal("stopped_run"),
  /** 停下來的原因，給人看的文字。 */
  reason: z.string(),
});
export type NeedsYouStoppedRun = z.infer<typeof NeedsYouStoppedRun>;

export const NeedsYouItem = z.discriminatedUnion("kind", [
  NeedsYouPermissionRequest,
  NeedsYouGate,
  NeedsYouStoppedRun,
]);
export type NeedsYouItem = z.infer<typeof NeedsYouItem>;
