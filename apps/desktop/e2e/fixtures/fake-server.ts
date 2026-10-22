// e2e 用的 fake Server：提供 Desktop 需要的 API、一個代替 Web UI 的簡單頁面，以及 Runner 的 WebSocket 端點。
// 協定 frame 用 @orbis/protocol 的型別；API 的路徑與 Desktop 一致（server-api.ts 的 API_PATHS）。
// 一律聽 port 0。

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MeResponse, NeedsYouItem } from "@orbis/api-contract";
import {
  type Hello,
  PROTOCOL_VERSION,
  RUNNER_WS_PATH,
  type RunnerToServer,
  type ServerToRunner,
} from "@orbis/protocol";
import { WebSocketServer } from "ws";
import { SESSION_COOKIE } from "../../src/main/names";
import { API_PATHS } from "../../src/main/session/server-api";

export interface FakeServerState {
  /** 目前有效的 session（cookie 值）。 */
  sessions: Set<string>;
  pairingRequests: { hadSession: boolean; body: unknown }[];
  issuedPairingTokens: string[];
  hellos: Hello[];
  needsYou: NeedsYouItem[];
  needsYouRequests: number;
  /** 收到的所有 Runner frame 的 type，依序。 */
  runnerFrames: string[];
}

export interface FakeServer {
  url: string;
  state: FakeServerState;
  close(): Promise<void>;
}

export const FAKE_ME: Omit<MeResponse, "member"> & { member: NonNullable<MeResponse["member"]> } = {
  githubUserId: 42,
  githubLogin: "octo",
  name: "Octo",
  avatarUrl: null,
  member: { id: "member-1", teamId: "team-1", teamName: "Team", role: "owner" },
};

function sessionOf(req: IncomingMessage): string | null {
  const cookies = req.headers.cookie?.split(";").map((c) => c.trim()) ?? [];
  const entry = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return entry ? entry.slice(SESSION_COOKIE.length + 1) : null;
}

function page(path: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>fake web</title></head>
<body><h1 id="path">${path}</h1>
<a id="login" href="/test/login">登入</a>
<a id="logout" href="/test/logout">登出</a>
<a id="external" href="https://example.com/">外部連結</a>
</body></html>`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += chunk;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function startFakeServer(): Promise<FakeServer> {
  const state: FakeServerState = {
    sessions: new Set(),
    pairingRequests: [],
    issuedPairingTokens: [],
    hellos: [],
    needsYou: [],
    needsYouRequests: 0,
    runnerFrames: [],
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const session = sessionOf(req);
    const signedIn = session !== null && state.sessions.has(session);

    if (url.pathname === "/api/health") return json(res, 200, { ok: true });
    if (url.pathname === "/test/login") {
      const token = randomUUID();
      state.sessions.add(token);
      res.writeHead(302, {
        location: "/",
        "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
      });
      return res.end();
    }
    if (url.pathname === "/test/logout") {
      if (session) state.sessions.delete(session);
      res.writeHead(302, {
        location: "/",
        "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      });
      return res.end();
    }
    if (url.pathname === API_PATHS.me) {
      return signedIn ? json(res, 200, FAKE_ME) : json(res, 401, { error: "unauthorized" });
    }
    if (url.pathname === API_PATHS.pairingTokens && req.method === "POST") {
      state.pairingRequests.push({ hadSession: signedIn, body: await readBody(req) });
      if (!signedIn) return json(res, 401, { error: "unauthorized" });
      const token = `pt_e2e_${state.issuedPairingTokens.length + 1}`;
      state.issuedPairingTokens.push(token);
      return json(res, 201, { token, expiresAt: null });
    }
    if (url.pathname === API_PATHS.needsYou) {
      state.needsYouRequests += 1;
      return signedIn ? json(res, 200, state.needsYou) : json(res, 401, { error: "unauthorized" });
    }
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "not_found" });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page(url.pathname));
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== RUNNER_WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => {
        const frame = JSON.parse(String(data)) as RunnerToServer;
        state.runnerFrames.push(frame.type);
        if (frame.type !== "hello") return;
        state.hellos.push(frame);
        const pairing = frame.pairing;
        const ack: ServerToRunner = {
          type: "hello_ack",
          protocol_version: PROTOCOL_VERSION,
          runner_id: pairing.kind === "runner_token" ? pairing.runner_id : randomUUID(),
          runner_token: pairing.kind === "pairing_token" ? `rt_${randomUUID()}` : null,
          heartbeat_interval_ms: 200,
          resume: [],
        };
        ws.send(JSON.stringify(ack));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
