// 版本相容（ARCHITECTURE §16「版本相容」）：Desktop 把自己編譯進去的 API 版本、內建 Runner 的協定版本
// （兩者和 Desktop 來自同一個 commit），與 Server 由 `/api/health` 回報的版本比對，算出要更新哪一個元件。
// 純函式，不依賴 Electron。

import { API_VERSION, type ServerVersions } from "@orbis/api-contract";
import { PROTOCOL_VERSION } from "@orbis/protocol";

export interface LocalVersions {
  /** Desktop 使用的 Server↔Desktop 契約版本。 */
  api: number;
  /** 內建 Runner 的 Runner↔Server 協定版本。 */
  protocol: number;
}

/** 這個 Desktop 編譯進去的版本。 */
export const LOCAL_VERSIONS: LocalVersions = { api: API_VERSION, protocol: PROTOCOL_VERSION };

export type CompatibilityVerdict =
  | { kind: "compatible" }
  /** Desktop（含內建 Runner）比 Server 舊。 */
  | { kind: "update_desktop"; message: string; detail: string }
  /** Server 比 Desktop 舊，或沒有回報版本。 */
  | { kind: "update_server"; message: string; detail: string }
  /** 一邊的 API 版本較舊、另一邊的協定版本較舊：兩者都要更新。 */
  | { kind: "update_both"; message: string; detail: string };

export const UPDATE_DESKTOP_MESSAGE = "Desktop 版本過舊，請更新 Desktop";
export const UPDATE_SERVER_MESSAGE = "Server 版本過舊，請更新 Server";
export const UPDATE_BOTH_MESSAGE = "Desktop 與 Server 的版本互不相容，請把兩者都更新到最新版";

/**
 * 比對版本。`server` 為 undefined 表示 Server 的 `/api/health` 沒有回報版本：那是比 Phase 1 發布
 * 更早的 Server，一律視為 Server 過舊。
 */
export function checkCompatibility(
  local: LocalVersions,
  server: ServerVersions | undefined,
): CompatibilityVerdict {
  if (!server) {
    return {
      kind: "update_server",
      message: UPDATE_SERVER_MESSAGE,
      detail: "Server 沒有回報版本，比這個 Desktop 更早。",
    };
  }
  const desktopOld: string[] = [];
  const serverOld: string[] = [];
  const compare = (label: string, mine: number, theirs: number) => {
    if (mine < theirs) desktopOld.push(`Desktop 的${label} ${mine}，Server 需要 ${theirs}`);
    if (mine > theirs) serverOld.push(`Server 的${label} ${theirs}，Desktop 需要 ${mine}`);
  };
  compare("API 版本", local.api, server.api);
  compare("協定版本", local.protocol, server.protocol);
  if (desktopOld.length === 0 && serverOld.length === 0) return { kind: "compatible" };
  const detail = `${[...desktopOld, ...serverOld].join("；")}（Server v${server.server}）。`;
  if (desktopOld.length > 0 && serverOld.length > 0) {
    return { kind: "update_both", message: UPDATE_BOTH_MESSAGE, detail };
  }
  if (desktopOld.length > 0) {
    return { kind: "update_desktop", message: UPDATE_DESKTOP_MESSAGE, detail };
  }
  return { kind: "update_server", message: UPDATE_SERVER_MESSAGE, detail };
}

/** 兩個判定是否相同（用來避免同一個問題重複跳出對話框）。 */
export function sameVerdict(
  a: CompatibilityVerdict | null,
  b: CompatibilityVerdict | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind === "compatible" || b.kind === "compatible" || a.detail === b.detail;
}
