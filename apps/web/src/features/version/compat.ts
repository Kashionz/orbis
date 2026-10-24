// Server↔Web 的版本相容（ARCHITECTURE §16「版本相容」）：Web 把編譯進去的 API_VERSION 和 Server 由
// `/api/health` 回報的版本比對。Web 由 Server 提供，所以版本不同通常是瀏覽器快取了舊的 Web；也可能是
// 開發時 Web 比 Server 新。純函式，方便測試。

import { API_VERSION, type ServerVersions } from "@orbis/api-contract";

export type VersionNotice =
  /** Web 比 Server 舊（瀏覽器快取了舊版）：重新整理就好。 */
  | { kind: "reload"; message: string }
  /** Server 比 Web 舊，或沒有回報版本：要更新 Server。 */
  | { kind: "update_server"; message: string };

export const RELOAD_MESSAGE = "Web UI 有新版本，請重新整理";
export const UPDATE_SERVER_MESSAGE = "Server 版本過舊，請更新 Server";

export function versionNotice(
  server: ServerVersions | undefined,
  local: number = API_VERSION,
): VersionNotice | null {
  if (!server) {
    return { kind: "update_server", message: `${UPDATE_SERVER_MESSAGE}（Server 沒有回報版本）` };
  }
  if (server.api > local) {
    return {
      kind: "reload",
      message: `${RELOAD_MESSAGE}（Server 的 API 版本 ${server.api}，目前載入的是 ${local}）`,
    };
  }
  if (server.api < local) {
    return {
      kind: "update_server",
      message: `${UPDATE_SERVER_MESSAGE}（Server v${server.server} 的 API 版本 ${server.api}，Web 需要 ${local}）`,
    };
  }
  return null;
}
