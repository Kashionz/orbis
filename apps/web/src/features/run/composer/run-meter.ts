// 輸入框上方執行環境列的數值：經過時間、context 用量、費用、Worktree 路徑的縮寫（純函式）。

import type { RunUsage } from "@orbis/api-contract";

const pad = (n: number) => String(n).padStart(2, "0");

/** 經過時間：不到一小時為 `mm:ss`，否則 `h:mm:ss`。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Run 的經過時間：從開始執行到結束（還沒結束時到 `now`）；還沒開始時為 null。 */
export function elapsedMs(
  startedAt: string | null,
  endedAt: string | null,
  now: number,
): number | null {
  if (startedAt === null) return null;
  const end = endedAt === null ? now : Date.parse(endedAt);
  return Math.max(0, end - Date.parse(startedAt));
}

/** 短的 token 數：1000 以上為 `41.9k`。 */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export interface ContextUsage {
  /** 0–100 的整數百分比。 */
  percent: number;
  /** 超過 80% 時以警告色顯示。 */
  warn: boolean;
  /** 例如 `41.9k / 200.0k`。 */
  detail: string;
}

/** context 用量；Agent 沒有回報 context 的大小時為 null。 */
export function contextUsage(usage: RunUsage): ContextUsage | null {
  const used = usage.contextUsedTokens;
  const window = usage.contextWindowTokens;
  if (used === null || window === null || window <= 0) return null;
  const ratio = used / window;
  return {
    percent: Math.min(100, Math.round(ratio * 100)),
    warn: ratio > 0.8,
    detail: `${formatTokens(used)} / ${formatTokens(window)}`,
  };
}

/** 費用，例如 `$0.32`；Agent 沒有回報時為 null。 */
export function formatCost(usage: RunUsage): string | null {
  if (!usage.cost) return null;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: usage.cost.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(usage.cost.amount);
  } catch {
    return `${usage.cost.currency} ${usage.cost.amount.toFixed(2)}`;
  }
}

/**
 * Worktree 路徑的縮寫：家目錄換成 `~`（Windows 的 `C:\Users\<名稱>`、macOS 的 `/Users/<名稱>`、
 * Linux 的 `/home/<名稱>`），保留原本的分隔符號。
 */
export function shortenPath(path: string): string {
  return path
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~")
    .replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}
