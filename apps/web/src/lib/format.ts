// 時間與用量的顯示格式。

import type { RunUsage } from "@orbis/api-contract";
import type { Usage } from "@orbis/protocol";
import { getMessages, type Messages } from "../i18n";
import { languagePreference } from "./preferences";

const timeFormats = new Map<string, Intl.DateTimeFormat>();

/** 日期與時間，依目前的語言格式化（24 小時制）。 */
export function formatTime(iso: string, language: string = languagePreference.get()): string {
  let format = timeFormats.get(language);
  if (!format) {
    format = new Intl.DateTimeFormat(language, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    timeFormats.set(language, format);
  }
  return format.format(new Date(iso));
}

/** 相對時間：剛剛、N 分鐘前、N 小時前、N 天前。 */
export function formatRelativeTime(
  iso: string | number,
  now: number = Date.now(),
  t: Messages = getMessages(),
): string {
  const at = typeof iso === "number" ? iso : Date.parse(iso);
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < 60) return t.common.justNow;
  if (seconds < 3600) return t.common.minutesAgo(Math.floor(seconds / 60));
  if (seconds < 86400) return t.common.hoursAgo(Math.floor(seconds / 3600));
  return t.common.daysAgo(Math.floor(seconds / 86400));
}

/** 時長：45s、3m 12s、1h 5m。 */
export function formatDuration(totalSeconds: number, t: Messages = getMessages()): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return t.common.durationSeconds(seconds);
  if (seconds < 3600) return t.common.durationMinutes(Math.floor(seconds / 60), seconds % 60);
  return t.common.durationHours(Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60));
}

const numberFormat = new Intl.NumberFormat("en-US");

/** 例如 `上下文 1,200 / 200,000   輸出 400   USD 0.0125`；沒有任何資料時為 `—`。 */
export function formatUsage(usage: RunUsage, t: Messages = getMessages()): string {
  const parts: string[] = [];
  if (usage.contextUsedTokens !== null) {
    const window =
      usage.contextWindowTokens === null
        ? ""
        : ` / ${numberFormat.format(usage.contextWindowTokens)}`;
    parts.push(t.common.usageContext(`${numberFormat.format(usage.contextUsedTokens)}${window}`));
  }
  if (usage.outputTokens !== null) {
    parts.push(t.common.usageOutput(numberFormat.format(usage.outputTokens)));
  }
  if (usage.cost) parts.push(`${usage.cost.currency} ${usage.cost.amount.toFixed(4)}`);
  // 不用「·」當分隔符，以空白分開
  return parts.length === 0 ? "—" : parts.join("   ");
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
