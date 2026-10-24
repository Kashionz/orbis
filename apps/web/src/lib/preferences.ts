// 個人介面偏好（設定→一般、執行器），存在 localStorage，不經過 Server。

import { useEffect } from "react";
import { parseBoolean, parseEnum, persistentState, usePersistentState } from "./storage";

export const THEME_PREFERENCES = ["dark", "light", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type Theme = "dark" | "light";

export const LANGUAGES = ["zh-TW", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

/** 工作區的預設版面：分割（串流＋右側面板）或只有串流。 */
export const LAYOUTS = ["split", "stream"] as const;
export type Layout = (typeof LAYOUTS)[number];

/** 終端機分頁的 shell（提示字元跟著換）。 */
export const TERMINAL_SHELLS = ["powershell", "cmd", "git-bash"] as const;
export type TerminalShell = (typeof TERMINAL_SHELLS)[number];

export const themePreference = persistentState<ThemePreference>(
  "theme",
  "dark",
  parseEnum(THEME_PREFERENCES),
);

export const languagePreference = persistentState<Language>("lang", "zh-TW", parseEnum(LANGUAGES));

export const layoutPreference = persistentState<Layout>("layout", "split", parseEnum(LAYOUTS));

export const autoExpandToolsPreference = persistentState<boolean>(
  "auto-expand-tools",
  false,
  parseBoolean,
);

export const terminalShellPreference = persistentState<TerminalShell>(
  "shell",
  "powershell",
  parseEnum(TERMINAL_SHELLS),
);

const LIGHT_QUERY = "(prefers-color-scheme: light)";

export function resolveTheme(preference: ThemePreference, prefersLight: boolean): Theme {
  if (preference === "system") return prefersLight ? "light" : "dark";
  return preference;
}

function prefersLight(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(LIGHT_QUERY).matches === true;
}

export function applyTheme(preference: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(preference, prefersLight());
}

/** 把主題套到 `<html data-theme>`；跟隨系統時，系統切換深淺色會即時跟著換。 */
export function useThemeEffect(): void {
  const [preference] = usePersistentState(themePreference);
  useEffect(() => {
    applyTheme(preference);
    if (preference !== "system") return;
    const query = window.matchMedia?.(LIGHT_QUERY);
    if (!query) return;
    const onChange = () => applyTheme("system");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);
}

export interface Preferences {
  theme: ThemePreference;
  setTheme(value: ThemePreference): void;
  language: Language;
  setLanguage(value: Language): void;
  defaultLayout: Layout;
  setDefaultLayout(value: Layout): void;
  autoExpandTools: boolean;
  setAutoExpandTools(value: boolean): void;
  terminalShell: TerminalShell;
  setTerminalShell(value: TerminalShell): void;
}

export function usePreferences(): Preferences {
  const [theme, setTheme] = usePersistentState(themePreference);
  const [language, setLanguage] = usePersistentState(languagePreference);
  const [defaultLayout, setDefaultLayout] = usePersistentState(layoutPreference);
  const [autoExpandTools, setAutoExpandTools] = usePersistentState(autoExpandToolsPreference);
  const [terminalShell, setTerminalShell] = usePersistentState(terminalShellPreference);
  return {
    theme,
    setTheme,
    language,
    setLanguage,
    defaultLayout,
    setDefaultLayout,
    autoExpandTools,
    setAutoExpandTools,
    terminalShell,
    setTerminalShell,
  };
}
