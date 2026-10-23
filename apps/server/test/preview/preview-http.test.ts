// Preview 的狀態查詢、換票與 Preview 網址的登入保護（ARCHITECTURE §13）：真實的 Server 與 Postgres。
// Preview 網址的請求以 Host header 指定（`<run-id>.preview.test`），送到 Server 實際 listen 的 port。

import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { NAMES } from "@orbis/api-contract";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { runEvents, runs, sessions } from "../../src/db/schema";
import { ACCESS_CACHE_MS } from "../../src/preview/auth";
import { PREVIEW_CALLBACK_PATH, PREVIEW_COOKIE } from "../../src/preview/domain";
import { PreviewState } from "../../src/preview/state";
import { type RunningServer, startServer } from "../../src/server";
import {
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

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** 以指定的 Host 送出請求（fetch 不能改 Host）。 */
function raw(
  port: number,
  host: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host, ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** WebSocket upgrade 的結果：成功開啟，或 HTTP 狀態碼。 */
function upgrade(port: number, host: string, cookie?: string): Promise<number | "open"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/@vite/client`, {
      headers: { host, ...(cookie && { cookie }) },
    });
    ws.once("open", () => {
      ws.close();
      resolve("open");
    });
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", () => resolve(0));
  });
}

describe.skipIf(dbSkipReason !== null)("Preview 網址", () => {
  let database: TestDatabase;
  let ctx: TestContext;
  let server: RunningServer;
  let team: SeededTeam;
  let runId: string;
  let previewHost: string;

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
      })
      .returning();
    if (!run) throw new Error("建立 Run 失敗");
    runId = run.id;
    previewHost = `${runId}.${PREVIEW_DOMAIN}`;
  });

  afterEach(async () => {
    await server?.close();
  });

  const statePath = () => `/api/runs/${runId}/preview`;
  const authorizePath = (returnPath = "/") =>
    `/api/preview/${runId}/authorize?return=${encodeURIComponent(returnPath)}`;

  async function addEvent(seq: number, kind: string, payload: Record<string, unknown>) {
    await database.db.insert(runEvents).values({
      runId,
      seq,
      ts: new Date(),
      kind,
      payload: { kind, ...payload },
    });
  }

  async function state(cookie: string | null) {
    const response = await ctx.app.request(statePath(), {
      headers: cookie ? { cookie } : {},
    });
    return { status: response.status, body: (await response.json()) as unknown };
  }

  /** 以某位 Member 的身分換票，回傳 callback 的網址。 */
  async function authorize(cookie: string | null, returnPath = "/"): Promise<Response> {
    return ctx.app.request(authorizePath(returnPath), { headers: cookie ? { cookie } : {} });
  }

  /** 走完換票，回傳 preview cookie（`Cookie` header 的值）。 */
  async function previewCookie(memberCookie: string): Promise<string> {
    const location = (await authorize(memberCookie)).headers.get("location") ?? "";
    const callback = new URL(location);
    const res = await raw(server.port, previewHost, `${callback.pathname}${callback.search}`);
    expect(res.status).toBe(302);
    const setCookie = res.headers["set-cookie"]?.[0] ?? "";
    return setCookie.split(";")[0] ?? "";
  }

  describe("狀態", () => {
    it("依 Event 與 Run 的狀態回報啟動中、就緒、停止，並附上 Preview 網址", async () => {
      const viewer = team.members.viewer.cookie;
      const shareUrl = `http://${runId}.${PREVIEW_DOMAIN}/`;
      let res = await state(viewer);
      expect(res.status).toBe(200);
      expect(PreviewState.parse(res.body)).toEqual({
        status: "starting",
        runnerId: null,
        port: null,
        localUrl: null,
        shareUrl,
      });

      await addEvent(1, "preview_ready", { port: 41234, url: "http://localhost:41234/" });
      res = await state(viewer);
      expect(res.body).toEqual({
        status: "ready",
        runnerId: null,
        port: 41234,
        localUrl: "http://localhost:41234/",
        shareUrl,
      });

      // TODO(contract): 契約 v2 的 preview_stopped Event 合併後改用它（#29）。
      await addEvent(2, "error", {
        code: "internal",
        message: "Preview 已停止（exited，結束碼 1）：boom",
        fatal: false,
      });
      expect(((await state(viewer)).body as PreviewState).status).toBe("stopped");

      await addEvent(3, "preview_ready", { port: 41234, url: "http://localhost:41234/" });
      expect(((await state(viewer)).body as PreviewState).status).toBe("ready");
      await database.db.update(runs).set({ status: "canceled" }).where(eq(runs.id, runId));
      expect(((await state(viewer)).body as PreviewState).status).toBe("stopped");
    });

    it("沒有登入回 401，其他 Team 的人看不到", async () => {
      expect((await state(null)).status).toBe(401);
      const other = await seedTeam(database.db, "Other");
      expect((await state(other.members.owner.cookie)).status).toBe(404);
    });
  });

  describe("authorize", () => {
    it("能查看 Run 的人（含 Viewer）拿到一次性 ticket，轉到 Preview 網址的 callback", async () => {
      const res = await authorize(team.members.viewer.cookie, "/app?x=1");
      expect(res.status).toBe(302);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const location = new URL(res.headers.get("location") ?? "");
      expect(location.origin).toBe(`http://${previewHost}`);
      expect(location.pathname).toBe(PREVIEW_CALLBACK_PATH);
      expect(location.searchParams.get("ticket")).toMatch(/^[\w-]{40,}$/);
      expect(location.searchParams.get("return")).toBe("/app?x=1");
    });

    it("沒有登入時轉到登入頁；其他 Team 的人回 404；不安全的 return 改成 /", async () => {
      const anonymous = await authorize(null);
      expect(anonymous.status).toBe(302);
      expect(anonymous.headers.get("location")).toBe(`${PUBLIC_URL}/login`);
      const other = await seedTeam(database.db, "Other");
      expect((await authorize(other.members.owner.cookie)).status).toBe(404);
      const unsafe = await authorize(team.members.member.cookie, "//evil.test/");
      expect(new URL(unsafe.headers.get("location") ?? "").searchParams.get("return")).toBe("/");
    });

    it("Server 沒有設定 Preview 網域時回 404，狀態中沒有 Preview 網址", async () => {
      const plain = createTestContext(database.db, { publicUrl: PUBLIC_URL });
      const res = await plain.app.request(authorizePath(), {
        headers: { cookie: team.members.owner.cookie },
      });
      expect(res.status).toBe(404);
      const stateRes = await plain.app.request(statePath(), {
        headers: { cookie: team.members.owner.cookie },
      });
      expect(((await stateRes.json()) as PreviewState).shareUrl).toBeNull();
    });
  });

  describe("Preview 網址的登入保護", () => {
    it("沒有 preview cookie 時，頁面導覽轉到 authorize，其他請求回 401", async () => {
      const navigation = await raw(server.port, previewHost, "/app?x=1", {
        "sec-fetch-mode": "navigate",
        accept: "text/html",
      });
      expect(navigation.status).toBe(302);
      expect(navigation.headers.location).toBe(`${PUBLIC_URL}${authorizePath("/app?x=1")}`);
      const asset = await raw(server.port, previewHost, "/src/main.ts", {
        "sec-fetch-mode": "cors",
      });
      expect(asset.status).toBe(401);
      expect(await upgrade(server.port, previewHost)).toBe(401);
    });

    it("callback 以 ticket 換成 host-only 的 preview cookie，ticket 只能用一次", async () => {
      const location = new URL(
        (await authorize(team.members.member.cookie, "/app")).headers.get("location") ?? "",
      );
      const path = `${location.pathname}${location.search}`;
      const res = await raw(server.port, previewHost, path);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/app");
      const setCookie = res.headers["set-cookie"]?.[0] ?? "";
      expect(setCookie).toMatch(
        new RegExp(`^${PREVIEW_COOKIE}=[\\w-]+; Path=/; HttpOnly; SameSite=Lax$`),
      );
      expect(setCookie).not.toContain("Domain");

      const again = await raw(server.port, previewHost, path);
      expect(again.status).toBe(403);
      // 其他 Run 的 Preview 網址不能用這張 ticket
      const otherRun = `${runId.slice(0, -1)}${runId.endsWith("0") ? "1" : "0"}.${PREVIEW_DOMAIN}`;
      const other = await authorize(team.members.member.cookie);
      const otherLocation = new URL(other.headers.get("location") ?? "");
      expect(
        (await raw(server.port, otherRun, `${otherLocation.pathname}${otherLocation.search}`))
          .status,
      ).toBe(403);
    });

    it("有 preview cookie 時交給轉送；登出後 5 秒內失效", async () => {
      const cookie = await previewCookie(team.members.viewer.cookie);
      // TODO(contract): 轉送在契約 v2 之後提供，目前通過登入檢查的請求回 503（#29）。
      expect((await raw(server.port, previewHost, "/", { cookie })).status).toBe(503);
      expect(await upgrade(server.port, previewHost, cookie)).toBe(503);

      await database.db
        .delete(sessions)
        .where(eq(sessions.githubUserId, team.members.viewer.githubUserId));
      expect((await raw(server.port, previewHost, "/", { cookie })).status).toBe(503);
      ctx.clock.advance(ACCESS_CACHE_MS);
      const after = await raw(server.port, previewHost, "/", {
        cookie,
        "sec-fetch-mode": "navigate",
      });
      expect(after.status).toBe(302);
      expect(after.headers.location).toBe(`${PUBLIC_URL}${authorizePath("/")}`);
    });

    it("Preview 網址的保留路徑不轉送；其他 Host 照常是 API", async () => {
      const cookie = await previewCookie(team.members.owner.cookie);
      expect(
        (await raw(server.port, previewHost, `/__${NAMES.productSlug}/anything`, { cookie }))
          .status,
      ).toBe(404);
      const health = await raw(server.port, `127.0.0.1:${server.port}`, "/api/health");
      expect(health.status).toBe(200);
      // Preview 網址上沒有 Orbis 的 API
      expect((await raw(server.port, previewHost, "/api/health")).status).toBe(401);
    });
  });
});
