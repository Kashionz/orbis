// 看板的 Task Key 搜尋：輸入 `ORB-12`、`orb-12`、`12` 或前綴（例如 `ORB-1`）都可以。

import { parseTaskKey } from "@orbis/api-contract";

export interface TaskKeyQuery {
  /** 只輸入數字時比對流水號，否則比對 Task Key 的開頭。 */
  number: number | null;
  prefix: string;
  /** 輸入的是完整的 Task Key（或只有流水號），可以直接開啟。 */
  exact: boolean;
}

export function parseTaskKeyQuery(input: string): TaskKeyQuery | null {
  const normalized = input.trim().toUpperCase();
  if (normalized === "") return null;
  if (/^\d+$/.test(normalized)) {
    return { number: Number(normalized), prefix: "", exact: true };
  }
  return { number: null, prefix: normalized, exact: parseTaskKey(normalized) !== null };
}

/** Task Key 是否符合搜尋條件。 */
export function matchesTaskKey(key: string, query: TaskKeyQuery | null): boolean {
  if (!query) return true;
  if (query.number !== null) return parseTaskKey(key)?.number === query.number;
  return query.exact ? key === query.prefix : key.startsWith(query.prefix);
}
