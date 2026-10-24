// e2e 用的 fake Server：提供 Desktop 需要的 API、一個代替 Web UI 的簡單頁面，以及 Runner 的 WebSocket 端點。
// 協定 frame 用 @orbis/protocol 的型別；API 的路徑與回應用 @orbis/api-contract 的定義。
// 一律聽 port 0。

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  API_ROUTES,
  API_VERSION,
  type HealthResponse,
  type MeResponse,
  type NeedsYouItem,
  type PairingTokenCreated,
  type ServerVersions,
} from "@orbis/api-contract";
import { NAMES } from "@orbis/api-contract/names";
import {
  type Hello,
  PROTOCOL_VERSION,
  RUNNER_WS_PATH,
  type RunnerToServer,
  type ServerToRunner,
} from "@orbis/protocol";
import { WebSocketServer } from "ws";
import { SESSION_COOKIE } from "../../src/main/names";
import {
  type PreviewState,
  previewAuthorizePath,
  previewStatePath,
} from "../../src/main/preview/target";

export interface FakeServerState {
  /** 目前有效的 session（cookie 值）。 */
  sessions: Set<string>;
  pairingRequests: { hadSession: boolean; body: unknown }[];
  issuedPairingTokens: string[];
  hellos: Hello[];
  needsYou: NeedsYouItem[];
  needsYouRequests: number;
  /** `DELETE /api/runners/:id` 收到的 Runner ID。 */
  revokedRunners: string[];
  /** 收到的所有 Runner frame 的 type，依序。 */
  runnerFrames: string[];
  /** 各 Run 的 Preview 狀態（`GET /api/runs/:runId/preview`）。 */
  previews: Record<string, PreviewState>;
  /** authorize 換票的請求（Run ID）。 */
  previewAuthorizations: string[];
  /** 上傳的 Preview 截圖（blob ID → 內容）。 */
  screenshots: Map<string, Buffer>;
  /** Review Gate 的決定（Gate ID 與 request body）。 */
  gateDecisions: { gateId: string; body: unknown }[];
  /** 額外提供的靜態檔案（路徑 → 內容），例如打包好的測試頁。 */
  files: Record<string, { contentType: string; body: string | Buffer }>;
  /** `/api/health` 回報的版本；undefined 模擬比 Phase 1 更早、不回報版本的 Server。 */
  versions: ServerVersions | undefined;
  /** 以 `hello_rejected { reason: version_mismatch }` 拒絕所有 Runner（Server 的協定版本取 versions.protocol）。 */
  rejectHelloVersion: boolean;
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

/** Preview 網址換票的 callback 路徑（ARCHITECTURE §13）。 */
export const PREVIEW_CALLBACK_PATH = `/__${NAMES.productSlug}/callback`;

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
    revokedRunners: [],
    runnerFrames: [],
    previews: {},
    previewAuthorizations: [],
    screenshots: new Map(),
    gateDecisions: [],
    files: {},
    versions: { server: "0.0.0-fake", api: API_VERSION, protocol: PROTOCOL_VERSION },
    rejectHelloVersion: false,
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const session = sessionOf(req);
    const signedIn = session !== null && state.sessions.has(session);

    if (url.pathname === API_ROUTES.health) {
      const health: HealthResponse = {
        ok: true,
        apiOrigin: `http://${req.headers.host}`,
        ...(state.versions && { versions: state.versions }),
      };
      return json(res, 200, health);
    }
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
    if (url.pathname === API_ROUTES.authMe) {
      return signedIn ? json(res, 200, FAKE_ME) : json(res, 401, { error: "unauthorized" });
    }
    if (url.pathname === API_ROUTES.pairingTokens && req.method === "POST") {
      state.pairingRequests.push({ hadSession: signedIn, body: await readBody(req) });
      if (!signedIn) return json(res, 401, { error: "unauthorized" });
      const token = `pt_e2e_${state.issuedPairingTokens.length + 1}`;
      state.issuedPairingTokens.push(token);
      const created: PairingTokenCreated = {
        id: randomUUID(),
        kind: "local",
        token,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
      return json(res, 201, created);
    }
    const runnerPrefix = `${API_ROUTES.runners}/`;
    if (url.pathname.startsWith(runnerPrefix) && req.method === "DELETE") {
      if (!signedIn) return json(res, 401, { error: "unauthorized" });
      state.revokedRunners.push(decodeURIComponent(url.pathname.slice(runnerPrefix.length)));
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === API_ROUTES.needsYou) {
      state.needsYouRequests += 1;
      return signedIn ? json(res, 200, state.needsYou) : json(res, 401, { error: "unauthorized" });
    }
    for (const [runId, preview] of Object.entries(state.previews)) {
      if (url.pathname === previewStatePath(runId)) {
        return signedIn ? json(res, 200, preview) : json(res, 401, { error: "unauthorized" });
      }
      if (url.pathname === previewAuthorizePath(runId)) {
        // 換票：確認 session 後轉回 Preview 網址的 callback（ticket 的驗證由 Preview 端負責）
        if (!signedIn || !preview.shareUrl) return json(res, 401, { error: "unauthorized" });
        state.previewAuthorizations.push(runId);
        const callback = new URL(PREVIEW_CALLBACK_PATH, preview.shareUrl);
        callback.searchParams.set("ticket", `ticket-${state.previewAuthorizations.length}`);
        callback.searchParams.set("return", url.searchParams.get("return") ?? "/");
        res.writeHead(302, { location: callback.href });
        return res.end();
      }
    }
    const screenshotMatch = /^\/api\/runs\/([^/]+)\/preview\/screenshots$/.exec(url.pathname);
    if (screenshotMatch && req.method === "POST") {
      if (!signedIn) return json(res, 401, { error: "unauthorized" });
      // multipart 交給 Web 標準的 Response 解析
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const form = await new Response(Buffer.concat(chunks), {
        headers: { "content-type": req.headers["content-type"] ?? "" },
      }).formData();
      const file = form.get("file");
      if (!(file instanceof File)) return json(res, 400, { error: "invalid_input" });
      const blobId = randomUUID();
      state.screenshots.set(blobId, Buffer.from(await file.arrayBuffer()));
      return json(res, 201, { blobId });
    }
    const gateMatch = /^\/api\/gates\/([^/]+)\/decision$/.exec(url.pathname);
    if (gateMatch && req.method === "POST") {
      if (!signedIn) return json(res, 401, { error: "unauthorized" });
      state.gateDecisions.push({ gateId: gateMatch[1] ?? "", body: await readBody(req) });
      return json(res, 200, {});
    }
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "not_found" });
    const file = state.files[url.pathname];
    if (file) {
      res.writeHead(200, { "content-type": file.contentType });
      return res.end(file.body);
    }
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
        if (state.rejectHelloVersion) {
          const serverVersion = state.versions?.protocol ?? PROTOCOL_VERSION;
          const rejected: ServerToRunner = {
            type: "hello_rejected",
            reason: "version_mismatch",
            server_protocol_version: serverVersion,
            message: `Runner 協定版本 ${frame.protocol_version} 與 Server 的 ${serverVersion} 不相容，請更新 Runner（由 Desktop 代管的 Runner 請更新 Desktop）`,
          };
          ws.send(JSON.stringify(rejected));
          ws.close(1008, "version_mismatch");
          return;
        }
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
