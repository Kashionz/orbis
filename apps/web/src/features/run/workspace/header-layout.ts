// 工作區標題列依寬度逐步收合（純函式）。門檻照原型：英文的字比較寬，收合得比較早。
//
// 1. 寬度不夠時先藏共用成員的頭像與「中止執行」的文字（只留圖示）。
// 2. 再窄時「分享」只留圖示。
// 3. 最窄時標題的最小寬度與間距縮小。

export type HeaderLanguage = "zh-TW" | "en";

const THRESHOLDS: Record<HeaderLanguage, { wide: number; mid: number }> = {
  "zh-TW": { wide: 620, mid: 480 },
  en: { wide: 700, mid: 540 },
};

/** 最窄的一段，與語言無關。 */
const NARROW = 440;

export interface HeaderLayout {
  /** 顯示共用成員的頭像堆疊與「中止執行」的文字。 */
  wide: boolean;
  /** 「分享」顯示文字。 */
  shareLabel: boolean;
  /** 標題的最小寬度（px）。 */
  titleMinWidth: number;
  /** 項目之間的間距（px）。 */
  gap: number;
}

export function headerLayout(width: number | null, language: HeaderLanguage): HeaderLayout {
  // 還沒量到寬度時當成夠寬
  const w = width ?? Number.POSITIVE_INFINITY;
  const t = THRESHOLDS[language];
  const narrow = w < NARROW;
  return {
    wide: w >= t.wide,
    shareLabel: w >= t.mid,
    titleMinWidth: narrow ? 24 : 80,
    gap: narrow ? 8 : 12,
  };
}
