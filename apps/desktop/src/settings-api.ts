// 內建設定頁（Server URL、編輯器、終端機）與 main 之間的介面。設定頁是 Desktop 自己的本機頁面，
// 和 Web UI 的 bridge 分開，使用不同的 preload 與 IPC channel。

import type { ToolChoice, ToolPreset } from "./main/local-tools/presets";

export const SETTINGS_API_KEY = "desktopSettings";

export interface SettingsState {
  productName: string;
  serverUrl: string | null;
  editor: ToolChoice;
  terminal: ToolChoice;
  editorPresets: readonly ToolPreset[];
  terminalPresets: readonly ToolPreset[];
  pathPlaceholder: string;
}

export type SaveResult = { ok: true } | { ok: false; message: string };

export interface SettingsApi {
  getState(): Promise<SettingsState>;
  /** 驗證（含 `/api/health`）後儲存 Server URL，並載入 Web UI。 */
  saveServerUrl(input: string): Promise<SaveResult>;
  saveTools(tools: { editor: ToolChoice; terminal: ToolChoice }): Promise<SaveResult>;
}

export const SETTINGS_IPC = {
  getState: "desktop-settings:get-state",
  saveServerUrl: "desktop-settings:save-server-url",
  saveTools: "desktop-settings:save-tools",
} as const;
