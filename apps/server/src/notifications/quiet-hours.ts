// 勿擾時段（ARCHITECTURE §12.3）：每個人可以設定每天的勿擾時段（本人的時區），期間不送桌面推送；
// App 內的通知照常記錄，勿擾結束後也不補推。

export interface QuietHours {
  /** 開始時間，當地時間從 00:00 起算的分鐘數（0–1439）。 */
  startMinute: number;
  /** 結束時間（不含），同上。比開始時間小表示跨過午夜，例如 22:00–07:00。 */
  endMinute: number;
  /** IANA 時區，例如 `Asia/Taipei`。 */
  timeZone: string;
}

/** `at` 在 timeZone 的當地時間（從 00:00 起算的分鐘數）。 */
export function localMinuteOfDay(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/** `at` 是否在勿擾時段內。開始與結束相同表示沒有勿擾時段。 */
export function isInQuietHours(at: Date, quiet: QuietHours | null): boolean {
  if (!quiet || quiet.startMinute === quiet.endMinute) return false;
  const now = localMinuteOfDay(at, quiet.timeZone);
  return quiet.startMinute < quiet.endMinute
    ? now >= quiet.startMinute && now < quiet.endMinute
    : now >= quiet.startMinute || now < quiet.endMinute;
}

/** 是否為這個執行環境認得的 IANA 時區。 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
