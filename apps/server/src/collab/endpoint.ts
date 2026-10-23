// 共同編輯的 WebSocket 端點（ARCHITECTURE §12.1）：`/api/collab/<文件名稱>`，使用 y-websocket 協定
// （sync step 1／2、update、awareness）。
//
// 安全（同 `/api/ws`）：
// - upgrade 時檢查 Origin 必須是 Web 的 origin，並以 session cookie 認證。
// - 能查看文件所屬的 Task（或 Project）才能連線；能編輯 Task 才能修改，否則是唯讀（update 一律丟棄）。
// - 連線期間定期重新檢查 session 與權限：session 失效時以 4401 關閉，不能再查看時以 4403 關閉，
//   不能再編輯時改成唯讀。
//
// 文件的生命週期：第一個 client 連上時從 CollabStore 載入；修改後 debounce 寫回；
// 最後一個 client 離開時寫回並卸載；Server 關閉時全部寫回。

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { parse as parseCookie } from "hono/utils/cookie";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { ApiError } from "../http/errors";
import { type Actor, resolveActor } from "../http/session";
import type { Logger } from "../logger";
import { SESSION_COOKIE } from "../routes/auth";
import type { Services } from "../services";
import type { UpgradeRouter } from "../ws-upgrade";
import { type CollabAccess, collabAccess } from "./authz";
import { type CollabDocRef, parseCollabDocName } from "./doc-name";
import { type CollabPeer, type CollabPersistHook, CollabRoom } from "./room";
import type { CollabStore } from "./store";

// TODO(contract): 路徑改用 packages/api-contract 的 API_ROUTES（ORB-3 契約 v2）。
export const COLLAB_PATH_PREFIX = "/api/collab/";
/** 權限檢查結果的有效時間。 */
export const COLLAB_AUTHZ_RECHECK_MS = 30_000;
/** 文件修改後多久寫回 CollabStore。 */
export const COLLAB_PERSIST_DEBOUNCE_MS = 1_000;
/** 單一訊息的大小上限。 */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_INVALID_MESSAGE = 4400;

export interface CollabEndpointOptions {
  /** Web 的 origin；upgrade 請求的 Origin 必須與它相同。 */
  publicUrl: string;
  store: CollabStore;
  /** 測試用：權限檢查結果的有效時間。 */
  authzRecheckMs?: number;
  /** 測試用：寫回的 debounce。 */
  persistDebounceMs?: number;
  onPersisted?: CollabPersistHook;
}

export interface CollabEndpoint {
  connectedCount(): number;
  /** 目前載入中的文件數（測試用）。 */
  openDocumentCount(): number;
  /** 把所有載入中的文件寫回 CollabStore。 */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function attachCollabEndpoint(
  router: UpgradeRouter,
  services: Services,
  options: CollabEndpointOptions,
): CollabEndpoint {
  const log = services.logger.child({ component: "collab" });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const allowedOrigin = new URL(options.publicUrl).origin;
  const rooms = new Map<string, Promise<CollabRoom>>();
  const connections = new Set<CollabConnection>();
  const recheckMs = options.authzRecheckMs ?? COLLAB_AUTHZ_RECHECK_MS;

  const openRoom = (ref: CollabDocRef): Promise<CollabRoom> => {
    let room = rooms.get(ref.name);
    if (!room) {
      const created = new CollabRoom(
        ref,
        options.store,
        log,
        options.persistDebounceMs ?? COLLAB_PERSIST_DEBOUNCE_MS,
        options.onPersisted,
      );
      room = created.load().then(() => created);
      room.catch(() => rooms.delete(ref.name));
      rooms.set(ref.name, room);
    }
    return room;
  };

  /** 最後一個 client 離開後寫回並卸載（寫回期間又有人連上就保留）。 */
  const releaseRoom = async (room: CollabRoom): Promise<void> => {
    if (room.peerCount > 0) return;
    await room.flush();
    if (room.peerCount > 0 || (await rooms.get(room.ref.name)) !== room) return;
    rooms.delete(room.ref.name);
    room.destroy();
  };

  router.registerPrefix(COLLAB_PATH_PREFIX, (request, socket, head) => {
    handleUpgrade(request, socket, head).catch((error: unknown) => {
      log.error({ err: error }, "共同編輯連線失敗");
      socket.end("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    });
  });

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    // 瀏覽器一定會帶 Origin；沒有 Origin 的是非瀏覽器的 client，拿不到別人的 cookie。
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== allowedOrigin) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const ref = parseCollabDocName(decodeURIComponent(pathname.slice(COLLAB_PATH_PREFIX.length)));
    if (!ref) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const token = parseCookie(request.headers.cookie ?? "", SESSION_COOKIE)[SESSION_COOKIE];
    let actor: Actor;
    let access: CollabAccess;
    try {
      actor = await resolveActor(services.db, services.clock, token);
      access = await collabAccess(services.db, actor, ref);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const text = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found" }[
        error.status as 401 | 403 | 404
      ];
      socket.end(`HTTP/1.1 ${error.status} ${text ?? "Bad Request"}\r\n\r\n`);
      return;
    }
    const room = await openRoom(ref);
    room.reserve();
    let joined = false;
    socket.once("close", () => {
      if (joined) return;
      room.unreserve();
      void releaseRoom(room);
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      joined = true;
      const connection = new CollabConnection(ws, room, actor, token, access, services, recheckMs);
      connections.add(connection);
      room.join(connection);
      ws.on("close", () => {
        connection.stop();
        connections.delete(connection);
        room.leave(connection);
        releaseRoom(room).catch((error: unknown) =>
          log.error({ err: error, doc: ref.name }, "卸載共同編輯文件失敗"),
        );
      });
    });
  }

  const flushAll = async () => {
    const opened = await Promise.allSettled([...rooms.values()]);
    await Promise.all(
      opened.flatMap((result) => (result.status === "fulfilled" ? [result.value.flush()] : [])),
    );
  };

  return {
    connectedCount: () => connections.size,
    openDocumentCount: () => rooms.size,
    flush: flushAll,
    close: async () => {
      for (const connection of connections) connection.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await flushAll();
      for (const room of await Promise.allSettled([...rooms.values()])) {
        if (room.status === "fulfilled") room.value.destroy();
      }
      rooms.clear();
    },
  };
}

class CollabConnection implements CollabPeer {
  private readonly log: Logger;
  private readonly timer: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ws: WebSocket,
    private readonly room: CollabRoom,
    private actor: Actor,
    private readonly sessionToken: string | undefined,
    private access: CollabAccess,
    private readonly services: Services,
    recheckMs: number,
  ) {
    this.log = services.logger.child({
      component: "collab",
      doc: room.ref.name,
      memberId: actor.memberId,
    });
    ws.binaryType = "nodebuffer";
    ws.on("message", (data, isBinary) => this.enqueue(() => this.onMessage(data, isBinary)));
    ws.on("error", (error) => this.log.warn({ err: error }, "共同編輯 WebSocket 錯誤"));
    this.timer = setInterval(() => this.enqueue(() => this.reauthorize()), recheckMs);
    this.timer.unref();
  }

  get memberId(): string {
    return this.actor.memberId;
  }

  get writable(): boolean {
    return this.access === "write";
  }

  send(message: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(message);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue
      .then(task)
      .catch((error: unknown) => this.log.error({ err: error }, "處理共同編輯訊息時發生錯誤"));
  }

  private async onMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (!isBinary) {
      this.ws.close(CLOSE_INVALID_MESSAGE, "binary messages only");
      return;
    }
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    try {
      this.room.receive(this, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    } catch (error) {
      this.log.warn({ err: error }, "共同編輯訊息格式不正確，關閉連線");
      this.ws.close(CLOSE_INVALID_MESSAGE, "invalid message");
    }
  }

  /** 重新檢查 session 與權限。 */
  private async reauthorize(): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const { db, clock } = this.services;
    try {
      this.actor = await resolveActor(db, clock, this.sessionToken);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      this.ws.close(CLOSE_UNAUTHORIZED, "session expired");
      return;
    }
    try {
      this.access = await collabAccess(db, this.actor, this.room.ref);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      this.ws.close(CLOSE_FORBIDDEN, "forbidden");
    }
  }
}
