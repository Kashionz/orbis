// Preview 的轉送（ARCHITECTURE §13）：真實的 Server 與 Postgres，Runner 是這個測試自己的 WebSocket client
// （照協定送 preview frame 與 binary 資料），瀏覽器端以 Host header 指定 Preview 網址。

import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { PROTOCOL_VERSION, RUNNER_WS_PATH } from "@orbis/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { dispatches, runEvents, runs } from "../../src/db/schema";
import { closeReason, hostOnlyCookie } from "../../src/preview/relay";
import {
  decodePreviewData,
  encodePreviewData,
  PREVIEW_INITIAL_WINDOW,
  PREVIEW_MAX_CHUNK,
  type PreviewData,
  type PreviewDataKind,
} from "../../src/preview/wire";
import { type RunningServer, startServer } from "../../src/server";
import {
  client,
  createTestContext,
  resetDatabase,
  type SeededTeam,
  seedProject,
  seedReadyTask,
  seedTeam,
  type TestContext,
  unusedGitHubOAuth,
} from "../helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "../helpers/db";

const PUBLIC_URL = "http://localhost:5173";
const PREVIEW_DOMAIN = "preview.test";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pattern = (length: number) => Uint8Array.from({ length }, (_, i) => i % 251);

type Item = { kind: "frame"; frame: Record<string, unknown> } | { kind: "data"; data: PreviewData };

/** 扮演 Runner：完成 Pairing 後收發 preview frame 與 binary 資料。 */
class FakeRunner {
  readonly items: Item[] = [];
  private waiters: { match: (item: Item) => boolean; resolve: (item: Item) => void }[] = [];
  runnerId = "";

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      const item: Item = isBinary
        ? { kind: "data", data: decodePreviewData(new Uint8Array(bytes)) }
        : { kind: "frame", frame: JSON.parse(bytes.toString()) as Record<string, unknown> };
      const index = this.waiters.findIndex((w) => w.match(item));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter?.resolve(item);
      } else {
        this.items.push(item);
      }
    });
  }

  next(match: (item: Item) => boolean, what: string, timeoutMs = 10_000): Promise<Item> {
    const index = this.items.findIndex(match);
    if (index >= 0) return Promise.resolve(this.items.splice(index, 1)[0] as Item);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等不到 ${what}`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: (item) => {
          clearTimeout(timer);
          resolve(item);
        },
      });
    });
  }

  async frame(type: string, streamId?: number): Promise<Record<string, unknown>> {
    const item = await this.next(
      (i) =>
        i.kind === "frame" &&
        i.frame.type === type &&
        (streamId === undefined || i.frame.stream_id === streamId),
      type,
    );
    return (item as { frame: Record<string, unknown> }).frame;
  }

  async data(streamId: number): Promise<PreviewData> {
    const item = await this.next(
      (i) => i.kind === "data" && i.data.streamId === streamId,
      `stream ${streamId} 的資料`,
    );
    return (item as { data: PreviewData }).data;
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  sendData(kind: PreviewDataKind, streamId: number, payload: Uint8Array): void {
    this.ws.send(encodePreviewData({ kind, streamId, payload }));
  }

  /** 依 Server 給的 credit 送出資料：credit 用完就等 preview_window。 */
  async sendBody(
    streamId: number,
    bytes: Uint8Array,
    credit: { value: number },
    kinds: { more: PreviewDataKind; last: PreviewDataKind } = { more: "body", last: "body" },
  ): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength || bytes.byteLength === 0) {
      while (credit.value === 0) {
        const window = await this.frame("preview_window", streamId);
        credit.value += window.credit as number;
      }
      const size = Math.min(bytes.byteLength - offset, PREVIEW_MAX_CHUNK, credit.value);
      const last = offset + size === bytes.byteLength;
      this.sendData(
        last ? kinds.last : kinds.more,
        streamId,
        bytes.subarray(offset, offset + size),
      );
      credit.value -= size;
      offset += size;
      if (last) return;
    }
  }
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function raw(
  port: number,
  host: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { host, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

describe.skipIf(dbSkipReason !== null)("Preview 的轉送", () => {
  let database: TestDatabase;
  let ctx: TestContext;
  let server: RunningServer;
  let team: SeededTeam;
  let runner: FakeRunner;
  let runId: string;
  let host: string;
  let cookie: string;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    ctx = createTestContext(database.db, { previewDomain: PREVIEW_DOMAIN, publicUrl: PUBLIC_URL });
    server = await startServer({
      config: {
        port: 0,
        publicUrl: PUBLIC_URL,
        bootstrapOwnerGithubUserId: null,
        devPairingToken: null,
        runnerHeartbeatIntervalMs: 1000,
      },
      db: database.db,
      logger: ctx.logger,
      githubOAuth: unusedGitHubOAuth,
      services: ctx.services,
      dispatcherIntervalMs: 0,
    });
    team = await seedTeam(database.db);

    // Runner 完成 Pairing
    const pairing = await client(ctx.app, team.members.member.cookie).post<{ token: string }>(
      "/api/runner-pairing-tokens",
      { kind: "local" },
    );
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${RUNNER_WS_PATH}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    runner = new FakeRunner(ws);
    runner.send({
      type: "hello",
      protocol_version: PROTOCOL_VERSION,
      runner: { name: "preview-runner", runner_version: "0.1.0", os: "linux", arch: "x86_64" },
      pairing: { kind: "pairing_token", token: pairing.body.token },
    });
    runner.runnerId = (await runner.frame("hello_ack")).runner_id as string;

    const { project, repo } = await seedProject(database.db, team.teamId);
    const task = await seedReadyTask(database.db, project, repo.id, { status: "running" });
    const [run] = await database.db
      .insert(runs)
      .values({
        taskId: task.id,
        agent: "claude-code",
        permissionPolicy: "manual",
        target: "local",
        status: "running",
        runnerId: runner.runnerId,
      })
      .returning();
    if (!run) throw new Error("建立 Run 失敗");
    runId = run.id;
    host = `${runId}.${PREVIEW_DOMAIN}`;

    // 換票取得 preview cookie
    const authorize = await ctx.app.request(`/api/preview/${runId}/authorize?return=%2F`, {
      headers: { cookie: team.members.viewer.cookie },
    });
    const callback = new URL(authorize.headers.get("location") ?? "");
    const res = await raw(server.port, host, `${callback.pathname}${callback.search}`);
    cookie = String(res.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
  });

  afterEach(async () => {
    runner?.ws.close();
    await server?.close();
  });

  it("HTTP 請求經由 Runner 轉送：移除 preview cookie 與偽造的 X-Forwarded-*，Set-Cookie 只屬於 Preview 網址", async () => {
    const response = raw(server.port, host, "/src/main.ts?t=1", {
      headers: { cookie: `${cookie}; app=1`, "x-forwarded-host": "evil.test" },
    });
    const open = await runner.frame("preview_open");
    expect(open).toMatchObject({
      run_id: runId,
      kind: "http",
      method: "GET",
      path: "/src/main.ts?t=1",
      window: PREVIEW_INITIAL_WINDOW,
    });
    const headers = new Map(open.headers as [string, string][]);
    expect(headers.get("host")).toBe(host);
    expect(headers.get("cookie")).toBe("app=1");
    expect(headers.get("x-forwarded-host")).toBeUndefined();
    expect(headers.get("x-forwarded-proto")).toBe("http");
    const id = open.stream_id as number;
    await runner.frame("preview_end", id);

    runner.send({
      type: "preview_response",
      stream_id: id,
      status: 200,
      headers: [
        ["content-type", "text/javascript"],
        ["set-cookie", "session=abc; Domain=preview.test; Path=/"],
        ["connection", "keep-alive"],
      ],
    });
    runner.sendData("body", id, new TextEncoder().encode("export default 1;"));
    runner.send({ type: "preview_end", stream_id: id });
    const res = await response;
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("export default 1;");
    expect(res.headers["content-type"]).toBe("text/javascript");
    expect(res.headers["set-cookie"]).toEqual(["session=abc; Path=/"]);
    expect(res.headers["content-security-policy"]).toBe(`frame-ancestors 'self' ${PUBLIC_URL}`);
  });

  it("大檔案依 credit 分段：Server 交給瀏覽器之後才補 credit", async () => {
    const big = pattern(3 * 1024 * 1024 + 123);
    const response = raw(server.port, host, "/big.bin", { headers: { cookie } });
    const open = await runner.frame("preview_open");
    const id = open.stream_id as number;
    runner.send({ type: "preview_response", stream_id: id, status: 200, headers: [] });
    const credit = { value: open.window as number };
    await runner.sendBody(id, big, credit);
    runner.send({ type: "preview_end", stream_id: id });
    const res = await response;
    expect(res.status).toBe(200);
    expect(res.body.byteLength).toBe(big.byteLength);
    expect(sha(res.body)).toBe(sha(big));
  });

  it("POST 的 body 依 Runner 給的 credit 送出", async () => {
    const payload = pattern(700 * 1024);
    const response = raw(server.port, host, "/api/echo", {
      method: "POST",
      headers: { cookie, "content-type": "application/octet-stream" },
      body: payload,
    });
    const open = await runner.frame("preview_open");
    const id = open.stream_id as number;
    expect(open.method).toBe("POST");
    // 扮演 Runner：收到的資料不超過給 Server 的 credit，寫出後才補
    const received: Uint8Array[] = [];
    let outstanding = PREVIEW_INITIAL_WINDOW;
    let total = 0;
    for (;;) {
      const item = await runner.next(
        (i) =>
          (i.kind === "data" && i.data.streamId === id) ||
          (i.kind === "frame" && i.frame.type === "preview_end" && i.frame.stream_id === id),
        "request body",
      );
      if (item.kind === "frame") break;
      const length = item.data.payload.byteLength;
      expect(length).toBeLessThanOrEqual(outstanding);
      outstanding -= length;
      total += length;
      received.push(Uint8Array.from(item.data.payload));
      runner.send({ type: "preview_window", stream_id: id, credit: length });
      outstanding += length;
    }
    expect(total).toBe(payload.byteLength);
    expect(sha(Buffer.concat(received))).toBe(sha(payload));
    runner.send({ type: "preview_response", stream_id: id, status: 204, headers: [] });
    runner.send({ type: "preview_end", stream_id: id });
    expect((await response).status).toBe(204);
  });

  it("WebSocket（HMR）雙向轉送，大訊息分段後組回；跨 origin 的 WebSocket 被拒絕", async () => {
    const origin = `http://${host}`;
    const browser = new WebSocket(`ws://127.0.0.1:${server.port}/@vite/client`, "vite-hmr", {
      headers: { host, cookie, origin },
    });
    const open = await runner.frame("preview_open");
    const id = open.stream_id as number;
    expect(open.kind).toBe("websocket");
    const headers = new Map(open.headers as [string, string][]);
    expect(headers.get("sec-websocket-protocol")).toBe("vite-hmr");
    expect(headers.get("sec-websocket-key")).toBeUndefined();
    // preview cookie 不可以轉給 dev server（Agent 寫的程式）
    expect(headers.get("cookie")).toBeUndefined();
    expect(JSON.stringify(open.headers)).not.toContain(cookie.split("=")[1]);
    runner.send({
      type: "preview_response",
      stream_id: id,
      status: 101,
      headers: [["sec-websocket-protocol", "vite-hmr"]],
    });
    await new Promise<void>((resolve, reject) => {
      browser.once("open", () => resolve());
      browser.once("error", reject);
    });
    expect(browser.protocol).toBe("vite-hmr");

    const messages: string[] = [];
    browser.on("message", (data) => messages.push(data.toString()));
    browser.send("hello");
    const hello = await runner.data(id);
    expect(hello.kind).toBe("ws_text");
    expect(new TextDecoder().decode(hello.payload)).toBe("hello");

    const big = "x".repeat(300 * 1024);
    await runner.sendBody(
      id,
      new TextEncoder().encode(big),
      { value: PREVIEW_INITIAL_WINDOW },
      { more: "ws_fragment", last: "ws_text" },
    );
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toBe(big);

    const closed = new Promise<number>((resolve) => browser.once("close", (code) => resolve(code)));
    runner.send({ type: "preview_ws_close", stream_id: id, code: 1000, reason: "bye" });
    expect(await closed).toBe(1000);

    // 其他 Run 的 Preview 頁面（same-site）不能連這個 Preview 的 WebSocket
    const evil = new WebSocket(`ws://127.0.0.1:${server.port}/@vite/client`, {
      headers: { host, cookie, origin: `http://other.${PREVIEW_DOMAIN}` },
    });
    const status = await new Promise<number>((resolve) =>
      evil.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)),
    );
    expect(status).toBe(403);
  });

  it("其他 origin 的子資源請求被拒絕；頁面導覽不受影響", async () => {
    const crossSite = await raw(server.port, host, "/api/data", {
      headers: { cookie, "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" },
    });
    expect(crossSite.status).toBe(403);
    // 跨站的表單 POST（頁面導覽）也不行
    const formPost = await raw(server.port, host, "/api/save", {
      method: "POST",
      headers: {
        cookie,
        "sec-fetch-site": "same-site",
        "sec-fetch-mode": "navigate",
        origin: `http://other.${PREVIEW_DOMAIN}`,
      },
    });
    expect(formPost.status).toBe(403);
    const navigation = raw(server.port, host, "/", {
      headers: { cookie, "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" },
    });
    const open = await runner.frame("preview_open");
    runner.send({ type: "preview_response", stream_id: open.stream_id, status: 200, headers: [] });
    runner.send({ type: "preview_end", stream_id: open.stream_id });
    expect((await navigation).status).toBe(200);
  });

  it("Runner 中止或斷線時回 502，Run 沒有 Runner 時回 503", async () => {
    const response = raw(server.port, host, "/", { headers: { cookie } });
    const open = await runner.frame("preview_open");
    runner.send({
      type: "preview_reset",
      stream_id: open.stream_id,
      reason: "upstream_error",
      message: "連不上 dev server（port 41000）",
    });
    const reset = await response;
    expect(reset.status).toBe(502);
    expect(reset.body.toString()).toContain("連不上 dev server");

    const pending = raw(server.port, host, "/slow", { headers: { cookie } });
    await runner.frame("preview_open");
    runner.ws.close();
    expect((await pending).status).toBe(502);

    const offline = await raw(server.port, host, "/", { headers: { cookie } });
    expect(offline.status).toBe(503);
    expect(offline.body.toString()).toContain("離線");
  });

  it("重新啟動 Preview：送 restart_preview 給執行這個 Run 的 Runner", async () => {
    const [dispatch] = await database.db
      .insert(dispatches)
      .values({
        runId,
        runnerId: runner.runnerId,
        status: "accepted",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    await database.db.insert(runEvents).values({
      runId,
      seq: 1,
      ts: new Date(),
      kind: "worktree_ready",
      payload: {
        kind: "worktree_ready",
        worktree_path: "/wt/r1",
        branch: null,
        base_commit: "c".repeat(40),
        preview_port: 41234,
      },
    });
    const res = await ctx.app.request(`/api/runs/${runId}/preview/restart`, {
      method: "POST",
      headers: { cookie: team.members.member.cookie },
    });
    expect(res.status).toBe(202);
    const control = await runner.frame("run_control");
    expect(control).toMatchObject({
      run_id: runId,
      dispatch_id: dispatch?.id,
      action: "restart_preview",
    });
  });
});

describe("Preview 轉送的 header 處理", () => {
  it("Set-Cookie 移除 Domain 屬性", () => {
    expect(hostOnlyCookie("a=1; Domain=.example.com; Path=/; HttpOnly")).toBe(
      "a=1; Path=/; HttpOnly",
    );
    expect(hostOnlyCookie("a=1")).toBe("a=1");
  });

  it("WebSocket 的 close reason 依 UTF-8 bytes 截斷到 123", () => {
    expect(Buffer.byteLength(closeReason("中".repeat(100)))).toBe(123);
    expect(closeReason("ok")).toBe("ok");
  });
});
