// 事件串流各項目共用的資料與操作：展開狀態、成員、作者、目前時間、複製、開啟檔案等。

import type {
  AcceptanceCriterion,
  Member,
  PermissionPolicy,
  Run,
  RunSettings,
} from "@orbis/api-contract";
import type { PermissionPurpose } from "@orbis/protocol";
import { createContext, type ReactNode, useCallback, useContext, useState } from "react";

export interface StreamEnv {
  run: Run;
  members: ReadonlyMap<string, Member>;
  /** 執行中切換的紀錄（Run 的設定）；還沒取得時為 null。 */
  settings: RunSettings | null;
  criteria: ReadonlyMap<string, AcceptanceCriterion>;
  /** 這個 Run 變更的檔案（訊息中的檔名連到差異分頁）。 */
  changedPaths: readonly string[];
  policy: PermissionPolicy;
  /** 目前時間（每 30 秒更新，相對時間用）。 */
  now: number;
  /** Plan Gate 等待核准的計畫的 seq。 */
  pendingPlanSeq: number | null;
  /** 要捲到並標示的項目 key。 */
  focusKey: string | null;
  isOpen: (key: string, defaultOpen: boolean) => boolean;
  toggle: (key: string, defaultOpen: boolean) => void;
  canRespond: (purpose: PermissionPurpose) => boolean;
  respondingRequestId: string | null;
  respond: (requestId: string, optionId: string) => void;
  openFile: (path: string) => void;
  copy: (text: string) => void;
  /** 把 prompt 的文字放進輸入框（編輯後重送）。 */
  editPrompt: (text: string) => void;
  /** 收回還在排隊的訊息；不能操作時為 null。 */
  withdrawPrompt: ((controlId: string) => void) | null;
}

const StreamContext = createContext<StreamEnv | null>(null);

export function StreamProvider({ env, children }: { env: StreamEnv; children: ReactNode }) {
  return <StreamContext.Provider value={env}>{children}</StreamContext.Provider>;
}

export function useStreamEnv(): StreamEnv {
  const env = useContext(StreamContext);
  if (!env) throw new Error("useStreamEnv 必須在 StreamProvider 中使用");
  return env;
}

/** 展開與收合：只記住手動切換過的項目，其他依各自的預設。 */
export function useExpansion(): Pick<StreamEnv, "isOpen" | "toggle"> {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const isOpen = useCallback(
    (key: string, defaultOpen: boolean) => overrides.get(key) ?? defaultOpen,
    [overrides],
  );
  const toggle = useCallback((key: string, defaultOpen: boolean) => {
    setOverrides((previous) => {
      const next = new Map(previous);
      next.set(key, !(previous.get(key) ?? defaultOpen));
      return next;
    });
  }, []);
  return { isOpen, toggle };
}
