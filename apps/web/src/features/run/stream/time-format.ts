// 事件串流的時間顯示（純函式）：相對時間（剛剛、N 分鐘前）與時長（3m 12s）。文字由 i18n 提供。

export interface TimeWords {
  justNow: string;
  minutesAgo: (n: number) => string;
  hoursAgo: (n: number) => string;
  daysAgo: (n: number) => string;
  durationSeconds: (s: number) => string;
  durationMinutes: (m: number, s: number) => string;
  durationHours: (h: number, m: number) => string;
}

/** 相對於 `now` 的時間：一分鐘內是「剛剛」。 */
export function relativeTime(ts: string, now: number, words: TimeWords): string {
  const seconds = Math.max(0, (now - Date.parse(ts)) / 1000);
  if (seconds < 60) return words.justNow;
  if (seconds < 3600) return words.minutesAgo(Math.floor(seconds / 60));
  if (seconds < 86_400) return words.hoursAgo(Math.floor(seconds / 3600));
  return words.daysAgo(Math.floor(seconds / 86_400));
}

/** 時長：不到一分鐘「12s」、不到一小時「3m 12s」，之後「1h 5m」。至少 1 秒。 */
export function duration(totalSeconds: number, words: TimeWords): string {
  const s = Math.max(1, Math.round(totalSeconds));
  if (s < 60) return words.durationSeconds(s);
  if (s < 3600) return words.durationMinutes(Math.floor(s / 60), s % 60);
  return words.durationHours(Math.floor(s / 3600), Math.floor((s % 3600) / 60));
}
