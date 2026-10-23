// Preview 的狀態查詢、換票與 Preview 網址的登入保護（ARCHITECTURE §13）：真實的 Server 與 Postgres。
// Preview 網址的請求以 Host header 指定（`<run-id>.preview.test`），送到 Server 實際 listen 的 port。

import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { NAMES, PREVIEW_SCREENSHOT_MAX_BYTES, PreviewState } from "@orbis/api-contract";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { runEvents, runs, sessions } from "../../src/db/schema";
import { ACCESS_CACHE_MS } from "../../src/preview/auth";
import { PREVIEW_CALLBACK_PATH, PREVIEW_COOKIE } from "../../src/preview/domain";
import { type RunningServer, startServer } from "../../src/server";
import {
  createTestContext,
  expectContract,
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
    it("依 Event 與 Run 的狀態回報沒有設定、啟動中、就緒、停止，就緒時附上 Preview 網址", async () => {
      const viewer = team.members.viewer.cookie;
      const shareUrl = `http://${runId}.${PREVIEW_DOMAIN}/`;
      const parse = async () => expectContract(PreviewState, (await state(viewer)).body);
      // 還沒建立 Worktree：不知道有沒有設定
      expect(await parse()).toEqual({
        status: "starting",
        runnerId: null,
        port: null,
        localUrl: null,
        shareUrl: null,
        stopped: null,
      });

      await addEvent(1, "worktree_ready", {
        worktree_path: "/wt/r1",
        branch: `${NAMES.branchPrefix}ORB-1-x`,
        base_commit: "c".repeat(40),
        preview_port: 41234,
      });
      expect(await parse()).toMatchObject({ status: "starting", port: 41234, shareUrl: null });

      await addEvent(2, "preview_ready", { port: 41234, url: "http://localhost:41234/" });
      expect(await parse()).toEqual({
        status: "ready",
        runnerId: null,
        port: 41234,
        localUrl: "http://localhost:41234/",
        shareUrl,
        stopped: null,
      });

      await addEvent(3, "preview_stopped", {
        reason: "exited",
        exit_code: 1,
        output: "boom",
      });
      expect(await parse()).toMatchObject({
        status: "stopped",
        shareUrl: null,
        stopped: { reason: "exited", exitCode: 1, output: "boom" },
      });

      // 重新啟動後就緒：最近一次停止的原因仍然保留
      await addEvent(4, "preview_ready", { port: 41234, url: "http://localhost:41234/" });
      expect(await parse()).toMatchObject({ status: "ready", stopped: { reason: "exited" } });
      await database.db.update(runs).set({ status: "canceled" }).where(eq(runs.id, runId));
      expect((await parse()).status).toBe("stopped");
    });

    it("worktree_ready 沒有 preview_port 時是沒有設定", async () => {
      await addEvent(1, "worktree_ready", {
        worktree_path: "/wt/r1",
        branch: `${NAMES.branchPrefix}ORB-1-x`,
        base_commit: "c".repeat(40),
      });
      const res = await state(team.members.viewer.cookie);
      expect(expectContract(PreviewState, res.body).status).toBe("not_configured");
    });

    it("重新啟動：需要能編輯 Task；沒有設定 Preview、Run 已結束或不在 Runner 上時回 409", async () => {
      const restart = (cookie: string) =>
        ctx.app.request(`/api/runs/${runId}/preview/restart`, {
          method: "POST",
          headers: { cookie },
        });
      expect((await restart(team.members.viewer.cookie)).status).toBe(403);
      // 沒有 Dispatch：Runner 上沒有這個 Run
      expect((await restart(team.members.member.cookie)).status).toBe(409);
      await addEvent(1, "worktree_ready", {
        worktree_path: "/wt/r1",
        branch: null,
        base_commit: "c".repeat(40),
      });
      expect((await restart(team.members.member.cookie)).status).toBe(409);
      await database.db.update(runs).set({ status: "canceled" }).where(eq(runs.id, runId));
      expect((await restart(team.members.member.cookie)).status).toBe(409);
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
      await addEvent(1, "preview_ready", { port: 41234, url: "http://localhost:41234/" });
      const stateRes = await plain.app.request(statePath(), {
        headers: { cookie: team.members.owner.cookie },
      });
      const ready = (await stateRes.json()) as PreviewState;
      expect(ready.status).toBe("ready");
      expect(ready.shareUrl).toBeNull();
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
      // 通過登入檢查後交給轉送；這個 Run 沒有 Runner，所以轉送回 503
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

  describe("Preview 留言的截圖", () => {
    const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

    function upload(
      cookie: string,
      bytes: Uint8Array,
      headers: Record<string, string> = { origin: PUBLIC_URL, "sec-fetch-site": "same-origin" },
    ) {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "image/png" }), "screenshot.png");
      return ctx.app.request(`/api/runs/${runId}/preview/screenshots`, {
        method: "POST",
        headers: { cookie, ...headers },
        body: form,
      });
    }

    it("能退回 Review Gate 的人可以上傳 PNG，blob 掛在這個 Run 上，可以下載", async () => {
      const res = await upload(team.members.member.cookie, PNG);
      expect(res.status).toBe(201);
      const { blobId } = (await res.json()) as { blobId: string };
      const download = await ctx.app.request(`/api/blobs/${blobId}`, {
        headers: { cookie: team.members.viewer.cookie },
      });
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(PNG);
    });

    it("Viewer 不能上傳；不是 PNG 或超過上限時拒絕", async () => {
      expect((await upload(team.members.viewer.cookie, PNG)).status).toBe(403);
      expect((await upload(team.members.member.cookie, Uint8Array.from([1, 2, 3]))).status).toBe(
        400,
      );
      const big = new Uint8Array(PREVIEW_SCREENSHOT_MAX_BYTES + 1);
      big.set(PNG);
      expect((await upload(team.members.member.cookie, big)).status).toBe(413);
      const other = await seedTeam(database.db, "Other");
      expect((await upload(other.members.owner.cookie, PNG)).status).toBe(404);
    });

    it("只接受 Web UI 發出的請求（Preview 頁面是 same-site，會帶著 session cookie）", async () => {
      const fromPreview = await upload(team.members.member.cookie, PNG, {
        origin: `http://${previewHost}`,
        "sec-fetch-site": "same-site",
      });
      expect(fromPreview.status).toBe(403);
      const sameSiteOnly = await upload(team.members.member.cookie, PNG, {
        "sec-fetch-site": "same-site",
      });
      expect(sameSiteOnly.status).toBe(403);
    });
  });
});
