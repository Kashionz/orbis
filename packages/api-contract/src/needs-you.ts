// Needs You 項目：等待某位 Member 處理的權限請求、待核准的 Gate、停下來的 Run。

import { PERMISSION_OPTION_KINDS, PERMISSION_PURPOSES } from "@orbis/protocol";
import { z } from "zod";
import { Id, Timestamp } from "./common";
import { GateKind, StoppedRunReason } from "./enums";
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
  /** 請求的用途：一般 tool call、設定的信任核准（Admin 以上才能回覆）、Agent 設定檔被修改。 */
  purpose: z.enum(PERMISSION_PURPOSES),
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

const stoppedRunShape = {
  reasonCode: StoppedRunReason,
  /** 第幾輪 Verification；只有 `verification_limit` 有值。 */
  attempt: z.number().int().positive().nullable(),
  /** 原始的錯誤訊息（例如 git 的輸出），不翻譯，UI 以 code 字型顯示；沒有時為 null。 */
  detail: z.string().nullable(),
};

const attemptOnlyForVerificationLimit = (info: {
  reasonCode: StoppedRunReason;
  attempt: number | null;
}) => (info.attempt !== null) === (info.reasonCode === "verification_limit");
const attemptError = { error: "attempt 只在 verification_limit 時有值", path: ["attempt"] };

/** Run 停下來的原因與細節（API 版本 2，Needs You 與通知共用）。給人看的文字由 UI 依 `reasonCode` 在地化。 */
export const StoppedRunInfo = z
  .object(stoppedRunShape)
  .refine(attemptOnlyForVerificationLimit, attemptError);
export type StoppedRunInfo = z.infer<typeof StoppedRunInfo>;

/** 停下來等人處理的 Run：Verification 重試超過上限（§5.1）、push 或開 PR 失敗、本機合併被擋下。 */
export const NeedsYouStoppedRun = NeedsYouBase.extend({
  kind: z.literal("stopped_run"),
  ...stoppedRunShape,
}).refine(attemptOnlyForVerificationLimit, attemptError);
export type NeedsYouStoppedRun = z.infer<typeof NeedsYouStoppedRun>;

/**
 * Child Run 以 `ask_parent` 提出、父 Run 的回合已經結束而改由人回答的問題（§9）。
 * `runId` 是父 Run；以 `POST` childQuestionAnswer 回答。
 */
export const NeedsYouChildQuestion = NeedsYouBase.extend({
  kind: z.literal("child_question"),
  questionId: Id,
  childRunId: Id,
  question: z.string().min(1),
});
export type NeedsYouChildQuestion = z.infer<typeof NeedsYouChildQuestion>;

export const NeedsYouItem = z.discriminatedUnion("kind", [
  NeedsYouPermissionRequest,
  NeedsYouGate,
  NeedsYouStoppedRun,
  NeedsYouChildQuestion,
]);
export type NeedsYouItem = z.infer<typeof NeedsYouItem>;

/** `GET` Needs You 的回應：目前 Member 待處理的項目，依建立時間排序（新的在前）。 */
export const NeedsYouListResponse = z.array(NeedsYouItem);
export type NeedsYouListResponse = z.infer<typeof NeedsYouListResponse>;

/** 人回答 Child Run 的問題（`POST` childQuestionAnswer）。答案交給 Child Run 的 `ask_parent`。 */
export const AnswerChildQuestionInput = z.object({ answer: z.string().trim().min(1) }).strict();
export type AnswerChildQuestionInput = z.infer<typeof AnswerChildQuestionInput>;
