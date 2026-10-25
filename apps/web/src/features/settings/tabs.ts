/** 設定對話框的分頁（左側導覽的順序）。 */
export const SETTINGS_TABS = ["general", "runners", "agents", "notifications", "account"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === "string" && (SETTINGS_TABS as readonly string[]).includes(value);
}
