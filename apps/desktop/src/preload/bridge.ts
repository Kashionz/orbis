// 主視窗（Web UI）的 preload。sandbox 中執行，只透過 contextBridge 暴露 DesktopBridge 的幾個函式，
// 不暴露 ipcRenderer 本身。main 端還會再檢查呼叫來自 Server origin 的主 frame。

import { contextBridge, ipcRenderer } from "electron";
import { BRIDGE_IPC, DESKTOP_BRIDGE_KEY, type DesktopBridge } from "../bridge";

const bridge: DesktopBridge = {
  getVersion: () => ipcRenderer.invoke(BRIDGE_IPC.getVersion),
  openWorktreeInEditor: (worktreePath) =>
    ipcRenderer.invoke(BRIDGE_IPC.openWorktreeInEditor, String(worktreePath)),
  openWorktreeInTerminal: (worktreePath) =>
    ipcRenderer.invoke(BRIDGE_IPC.openWorktreeInTerminal, String(worktreePath)),
  beforeLogout: () => ipcRenderer.invoke(BRIDGE_IPC.beforeLogout),
};

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, bridge);
