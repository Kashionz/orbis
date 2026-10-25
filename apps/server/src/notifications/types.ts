// 發送通知的介面（ARCHITECTURE §12.3）。產生事件的服務（Gate、Verification、GitHub 整合…）只依賴這個介面，
// 實作見 notifications/service.ts。

import type { NotificationKind, StoppedRunInfo } from "@orbis/api-contract";
import type { UnitOfWork } from "../db/tx";

export interface NotifyRequest {
  kind: NotificationKind;
  /** 收件者；null 與重複的會被略過，操作者本人（actorMemberId）也不會收到。 */
  recipients: readonly (string | null | undefined)[];
  taskId: string | null;
  runId?: string | null;
  gateId?: string | null;
  /** 觸發的人；系統觸發時為 null。 */
  actorMemberId?: string | null;
  title: string;
  body?: string | null;
  /** 點擊後前往的 Web 路徑或網址；未提供時用 Task 的網址。 */
  url?: string | null;
  /** `run_stopped` 的原因與細節（UI 依代碼在地化）；其他種類省略。 */
  stoppedRun?: StoppedRunInfo | null;
}

export interface Notify {
  /**
   * 建立通知。傳入 UnitOfWork 時與它一起 commit（各 Channel 在 commit 之後才送出）；
   * 傳 null 時自己開 transaction，失敗只記 log，不會讓呼叫端失敗。
   */
  notify(uow: UnitOfWork | null, request: NotifyRequest): Promise<void>;
}

/** 不發送任何通知（單元測試用）。 */
export const NO_NOTIFY: Notify = { notify: async () => {} };
