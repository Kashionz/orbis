// 介面文字的 i18n。所有使用者看得到的文字都從這裡取得（模型名稱、CLI 代號等專有名詞除外）。
//
// ```tsx
// const t = useT();
// <button>{t.shell.settings}</button>
// <span>{t.labels.taskStatus[task.status]}</span>
// <span>{t.common.minutesAgo(3)}</span>
// ```
//
// 字典依 feature 拆檔（`zh-TW/<feature>.ts`、`en/<feature>.ts`），各 feature 只改自己的檔案。

import { createContext, type ReactNode, useContext, useEffect } from "react";
import { type Language, languagePreference } from "../lib/preferences";
import { usePersistentState } from "../lib/storage";
import { en } from "./en";
import type { Messages } from "./types";
import { zhTW } from "./zh-TW";

export type { Messages } from "./types";

export const DICTIONARIES: Record<Language, Messages> = { "zh-TW": zhTW, en };

const I18nContext = createContext<Language | null>(null);

/** 目前的語言，提供 `useT()`；切換語言時 `html[lang]` 跟著換。 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [language] = usePersistentState(languagePreference);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  return <I18nContext.Provider value={language}>{children}</I18nContext.Provider>;
}

/** 目前語言的字典。沒有 Provider 時（例如獨立的測試頁）讀 localStorage 的設定。 */
export function useT(): Messages {
  const language = useContext(I18nContext) ?? languagePreference.get();
  return DICTIONARIES[language];
}

export function useLanguage(): Language {
  return useContext(I18nContext) ?? languagePreference.get();
}

/** 給元件以外的程式（格式化函式、錯誤訊息）用：目前設定的語言的字典。 */
export function getMessages(): Messages {
  return DICTIONARIES[languagePreference.get()];
}
