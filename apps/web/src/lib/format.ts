// 時間與用量的顯示格式。

import type { RunUsage } from "@orbis/api-contract";
import type { Usage } from "@orbis/protocol";

const timeFormat = new Intl.DateTimeFormat("zh-TW", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

const numberFormat = new Intl.NumberFormat("en-US");

/** 例如 `context 1,200 / 200,000 · 輸出 400 · USD 0.0125`；沒有任何資料時為 `—`。 */
export function formatUsage(usage: RunUsage): string {
  const parts: string[] = [];
  if (usage.contextUsedTokens !== null) {
    const window =
      usage.contextWindowTokens === null
        ? ""
        : ` / ${numberFormat.format(usage.contextWindowTokens)}`;
    parts.push(`context ${numberFormat.format(usage.contextUsedTokens)}${window}`);
  }
  if (usage.outputTokens !== null) parts.push(`輸出 ${numberFormat.format(usage.outputTokens)}`);
  if (usage.cost) parts.push(`${usage.cost.currency} ${usage.cost.amount.toFixed(4)}`);
  return parts.length === 0 ? "—" : parts.join(" · ");
}

/** 協定的 Usage（snake_case）轉成 REST 的 RunUsage。 */
export function toRunUsage(usage: Usage): RunUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    thoughtTokens: usage.thought_tokens,
    cachedReadTokens: usage.cached_read_tokens,
    cachedWriteTokens: usage.cached_write_tokens,
    contextUsedTokens: usage.context_used_tokens,
    contextWindowTokens: usage.context_window_tokens,
    cost: usage.cost,
  };
}
