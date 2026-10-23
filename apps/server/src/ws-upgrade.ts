// 依路徑分派 HTTP upgrade 到各個 WebSocket 端點（Runner 的 `/runner`、Web 的即時推送）。
// 沒有登記的路徑直接關閉連線。

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

export class UpgradeRouter {
  private readonly handlers = new Map<string, UpgradeHandler>();
  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const handler = this.handlers.get(path);
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

  close(): void {
    this.server.off("upgrade", this.onUpgrade);
  }
}
