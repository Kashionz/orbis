// Server↔Web 的版本相容（ARCHITECTURE §16「版本相容」）：Web 把編譯進去的 API_VERSION 和 Server 由
// `/api/health` 回報的版本比對。Web 由 Server 提供，所以版本不同通常是瀏覽器快取了舊的 Web；也可能是
// 開發時 Web 比 Server 新。純函式，方便測試；訊息依目前的語言。

import { API_VERSION, type ServerVersions } from "@orbis/api-contract";
import { getMessages, type Messages } from "../../i18n";

export type VersionNotice =
  /** Web 比 Server 舊（瀏覽器快取了舊版）：重新整理就好。 */
  | { kind: "reload"; message: string }
  /** Server 比 Web 舊，或沒有回報版本：要更新 Server。 */
  | { kind: "update_server"; message: string };

export function versionNotice(
  server: ServerVersions | undefined,
  local: number = API_VERSION,
  t: Messages = getMessages(),
): VersionNotice | null {
  if (!server) return { kind: "update_server", message: t.version.noVersionsMessage };
  if (server.api > local) {
    return { kind: "reload", message: t.version.reloadMessage(server.api, local) };
  }
  if (server.api < local) {
    return {
      kind: "update_server",
      message: t.version.updateServerMessage(server.server, server.api, local),
    };
  }
  return null;
}
