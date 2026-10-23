// 依路徑分派 HTTP upgrade 到各個 WebSocket 端點（Runner 的 `/runner`、Web 的即時推送、
// 共同編輯的 `/api/collab/<文件>`）。依 Host 登記的處理（Preview 網址）最優先，其次是完全相同的路徑，
// 再來是路徑前綴。沒有登記的路徑直接關閉連線。

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

export class UpgradeRouter {
  private readonly handlers = new Map<string, UpgradeHandler>();
  private readonly hostHandlers: {
    match: (host: string | undefined) => boolean;
    handler: UpgradeHandler;
  }[] = [];
  private readonly prefixHandlers: { prefix: string; handler: UpgradeHandler }[] = [];
  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const byHost = this.hostHandlers.find((h) => h.match(request.headers.host));
    if (byHost) {
      byHost.handler(request, socket, head);
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const handler =
      this.handlers.get(path) ??
      this.prefixHandlers.find((entry) => path.startsWith(entry.prefix))?.handler;
    if (!handler) {
      socket.destroy();
      return;
    }
    handler(request, socket, head);
  };

  constructor(private readonly server: Server) {
    server.on("upgrade", this.onUpgrade);
  }

  register(path: string, handler: UpgradeHandler): void {
    this.handlers.set(path, handler);
  }

  /** 依 Host 分派（Preview 網址），優先於路徑。 */
  registerHost(match: (host: string | undefined) => boolean, handler: UpgradeHandler): void {
    this.hostHandlers.push({ match, handler });
  }

  /** 以路徑前綴登記（例如 `/api/collab/`，後面接文件名稱）。 */
  registerPrefix(prefix: string, handler: UpgradeHandler): void {
    this.prefixHandlers.push({ prefix, handler });
  }

  close(): void {
    this.server.off("upgrade", this.onUpgrade);
  }
}
