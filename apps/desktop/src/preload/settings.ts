// 內建設定頁的 preload（sandbox）。

import { contextBridge, ipcRenderer } from "electron";
import { SETTINGS_API_KEY, SETTINGS_IPC, type SettingsApi } from "../settings-api";

const api: SettingsApi = {
  getState: () => ipcRenderer.invoke(SETTINGS_IPC.getState),
  saveServerUrl: (input) => ipcRenderer.invoke(SETTINGS_IPC.saveServerUrl, String(input)),
  saveTools: (tools) => ipcRenderer.invoke(SETTINGS_IPC.saveTools, tools),
};

contextBridge.exposeInMainWorld(SETTINGS_API_KEY, api);
