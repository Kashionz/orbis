// 主視窗（Web UI）的 preload。sandbox 中執行，只透過 contextBridge 暴露 DesktopBridge 的幾個函式，
// 不暴露 ipcRenderer 本身。main 端還會再檢查呼叫來自 Server origin 的主 frame。

import { contextBridge, ipcRenderer } from "electron";
import {
  BRIDGE_IPC,
  DESKTOP_BRIDGE_KEY,
  type DesktopBridge,
  type PreviewNavState,
} from "../bridge";

const bridge: DesktopBridge = {
  getVersion: () => ipcRenderer.invoke(BRIDGE_IPC.getVersion),
  openWorktreeInEditor: (worktreePath) =>
    ipcRenderer.invoke(BRIDGE_IPC.openWorktreeInEditor, String(worktreePath)),
  openWorktreeInTerminal: (worktreePath) =>
    ipcRenderer.invoke(BRIDGE_IPC.openWorktreeInTerminal, String(worktreePath)),
  beforeLogout: () => ipcRenderer.invoke(BRIDGE_IPC.beforeLogout),
  preview: {
    show: (runId, bounds) => ipcRenderer.invoke(BRIDGE_IPC.previewShow, String(runId), bounds),
    setBounds: (bounds) => ipcRenderer.invoke(BRIDGE_IPC.previewSetBounds, bounds),
    hide: () => ipcRenderer.invoke(BRIDGE_IPC.previewHide),
    reload: () => ipcRenderer.invoke(BRIDGE_IPC.previewReload),
    goBack: () => ipcRenderer.invoke(BRIDGE_IPC.previewGoBack),
    goForward: () => ipcRenderer.invoke(BRIDGE_IPC.previewGoForward),
    navigate: (url) => ipcRenderer.invoke(BRIDGE_IPC.previewNavigate, String(url)),
    openDevTools: () => ipcRenderer.invoke(BRIDGE_IPC.previewOpenDevTools),
    pickElement: () => ipcRenderer.invoke(BRIDGE_IPC.previewPickElement),
    onNavState: (listener) => {
      // 不把 IpcRendererEvent 傳給 Web UI，只傳狀態本身
      const handler = (_event: unknown, state: PreviewNavState) => listener(state);
      ipcRenderer.on(BRIDGE_IPC.previewNavState, handler);
      return () => {
        ipcRenderer.removeListener(BRIDGE_IPC.previewNavState, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, bridge);
