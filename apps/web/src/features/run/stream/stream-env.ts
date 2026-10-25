// 事件串流的輔助判斷（純函式）：某個時間點的 Agent 與模型、訊息中的檔名是不是變更的檔案。

import type { Run } from "@orbis/api-contract";
import type { RunSettings } from "../types";

/** `ts` 那個時間點使用的 Agent 與模型（依執行中切換的紀錄）。 */
export function agentAt(
  ts: string,
  run: Pick<Run, "agent" | "model">,
  settings: Pick<RunSettings, "initial" | "changes"> | null,
): { agent: string; model: string | null } {
  if (!settings || settings.changes.length === 0) return { agent: run.agent, model: run.model };
  let current = { ...settings.initial };
  for (const change of settings.changes) {
    if (change.ts > ts) break;
    if (change.kind === "model") {
      current = { agent: change.agent ?? current.agent, model: change.model ?? current.model };
    }
  }
  return current;
}

/** 看起來像檔名（有副檔名、沒有空白）。 */
const FILE_LIKE = /^[\w@./\\-]+\.[A-Za-z0-9]{1,8}$/;

/**
 * 訊息中的行內 code 是否指向一個檔案：完全符合變更的路徑、或檔名符合某個變更的檔案時回傳那個路徑；
 * 看起來像檔名但不在變更中時回傳原文（點擊後在差異分頁找不到就停在目前的檔案）；其他回傳 null。
 */
export function fileReference(code: string, paths: readonly string[]): string | null {
  const text = code.trim();
  if (paths.includes(text)) return text;
  const normalized = text.replace(/\\/g, "/");
  const match =
    paths.find((path) => path === normalized) ??
    paths.find((path) => path.endsWith(`/${normalized}`)) ??
    paths.find((path) => path.split("/").pop() === normalized);
  if (match) return match;
  return FILE_LIKE.test(text) && !/^\d+(\.\d+)+$/.test(text) ? text : null;
}
