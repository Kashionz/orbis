// 互動式終端機的 WebSocket（`API_ROUTES.terminalWs`，ADR-0014）。
//
// - Origin 必須是 Web 的 origin；以 session cookie 認證，而且必須是開啟這個終端機的 session（只能接一次）。
// - Web → Server：`input`（base64，解碼後最多 TERMINAL_MAX_CHUNK）、`resize`；Server → Web：`output`、`exited`、`error`。
// - WebSocket 關閉就關閉終端機。

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  API_ROUTES,
  TERMINAL_MAX_CHUNK,
  TerminalClientMessage,
  type TerminalServerMessage,
} from "@orbis/api-contract";
import { parse as parseCookie } from "hono/utils/cookie";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { findSession } from "../auth/service";
import { SESSION_COOKIE } from "../routes/auth";
import type { Services } from "../services";
import type { UpgradeRouter } from "../ws-upgrade";

const PREFIX = API_ROUTES.terminalWs.slice(0, API_ROUTES.terminalWs.indexOf(":terminalId"));
const SUFFIX = API_ROUTES.terminalWs.slice(API_ROUTES.terminalWs.indexOf(":terminalId") + 11);

/** 路徑中的 terminal id；不是終端機的路徑時為 null。 */
export function terminalIdFromPath(path: string): string | null {
  if (!path.startsWith(PREFIX) || !path.endsWith(SUFFIX)) return null;
  const id = path.slice(PREFIX.length, path.length - SUFFIX.length);
  return z.uuid().safeParse(id).success ? id : null;
}

export interface TerminalEndpoint {
  close(): Promise<void>;
}

export function attachTerminalEndpoint(
  router: UpgradeRouter,
  services: Services,
  options: { publicUrl: string },
): TerminalEndpoint {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const allowedOrigin = new URL(options.publicUrl).origin;
  const refuse = (socket: Duplex, status: 401 | 403 | 404) => {
    const text = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found" }[status];
    socket.end(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
  };

  router.registerPrefix(PREFIX, (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const terminalId = terminalIdFromPath(path);
    if (!terminalId) return refuse(socket, 404);
    // 瀏覽器一定會帶 Origin；終端機是高權限的操作，沒有 Origin 也拒絕。
    if (request.headers.origin !== allowedOrigin) return refuse(socket, 403);
    const token = parseCookie(request.headers.cookie ?? "", SESSION_COOKIE)[SESSION_COOKIE];
    if (!token) return refuse(socket, 401);
    findSession(services.db, token, services.clock.now()).then(
      (session) => {
        if (!session) return refuse(socket, 401);
        if (!services.terminals.canAttach(terminalId, session.id)) return refuse(socket, 403);
        wss.handleUpgrade(request, socket, head, (ws) => {
          const send = (message: TerminalServerMessage) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
          };
          const attached = services.terminals.attach(terminalId, session.id, {
            send,
            close: () => ws.close(1000),
          });
          if (!attached) {
            send({ type: "error", code: "forbidden", message: "這個終端機已經有連線或已經關閉" });
            ws.close(1008);
            return;
          }
          ws.on("message", (data: RawData, isBinary: boolean) => {
            const message = isBinary ? null : parseMessage(data);
            if (!message) {
              send({ type: "error", code: "invalid_message", message: "訊息格式不正確" });
              return;
            }
            if (message.type === "input") {
              if (Buffer.from(message.data, "base64").length > TERMINAL_MAX_CHUNK) {
                send({ type: "error", code: "invalid_message", message: "單次輸入太大" });
                return;
              }
              services.terminals.input(terminalId, message.data);
            } else {
              services.terminals.resize(terminalId, message.cols, message.rows);
            }
          });
          ws.on("close", () => void services.terminals.close(terminalId, "closed"));
        });
      },
      () => refuse(socket, 401),
    );
  });

  return {
    close: () =>
      new Promise((resolve) => {
        services.terminals.closeAll();
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}

function parseMessage(data: RawData): TerminalClientMessage | null {
  try {
    const parsed = TerminalClientMessage.safeParse(JSON.parse(data.toString()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
