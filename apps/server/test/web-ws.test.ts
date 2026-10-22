// Web 的即時推送（WebSocket）：從任一 seq 重播後接上即時串流、不漏不重、權限檢查。

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NAMES } from "@orbis/api-contract";
import type { EventKind } from "@orbis/protocol";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BlobCleanup } from "../src/blobs/cleanup";
import { createBlobRoutes } from "../src/blobs/routes";
import {
  BLOB_RETENTION_MS,
  blobStorageKey,
  FileSystemBlobStore,
  type MemoryBlobStore,
} from "../src/blobs/store";
import {
  PendingRunEvent,
  RUNNER_BLOB_PATH,
  WEB_WS_PATH,
  type WebServerMessage,
} from "../src/contract-pending";
import { blobs, members } from "../src/db/schema";
import {
  client,
  expectContract,
  resetDatabase,
  type SeededTeam,
  seedProject,
  seedReadyTask,
  seedTeam,
} from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import { type Harness, type MockRunner, startHarness, waitUntil } from "./helpers/runner-harness";

const ORIGIN = "http://localhost:5173";

/** Web 端的測試 client：收集收到的訊息。 */
class WebClient {
  readonly messages: WebServerMessage[] = [];
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => this.messages.push(JSON.parse(data.toString()) as WebServerMessage));
    this.opened = new Promise((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    this.closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  }

  subscribe(runId: string, afterSeq = 0): void {
    this.ws.send(JSON.stringify({ type: "subscribe_run", runId, afterSeq }));
  }

  events(runId: string): number[] {
    return this.messages.flatMap((m) =>
      m.type === "run_event" && m.event.runId === runId ? [m.event.seq] : [],
    );
  }

  close(): void {
    this.ws.close();
  }
}

describe.skipIf(dbSkipReason !== null)("Web 即時推送與 blob", () => {
  let database: TestDatabase;
  let h: Harness;
  let team: SeededTeam;
  let project: Awaited<ReturnType<typeof seedProject>>["project"];
  let repoId: string;
  const webClients: WebClient[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    h = await startHarness(database.db, { webAuthzRecheckMs: 0 });
    team = await seedTeam(database.db);
    const seeded = await seedProject(database.db, team.teamId);
    project = seeded.project;
    repoId = seeded.repo.id;
  });

  afterEach(async () => {
    for (const c of webClients.splice(0)) c.close();
    await h.close();
  });

  async function connectWeb(cookie: string | null, origin: string | null = ORIGIN) {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const web = new WebClient(
      new WebSocket(`ws://127.0.0.1:${h.server.port}${WEB_WS_PATH}`, { headers }),
    );
    webClients.push(web);
    await web.opened;
    return web;
  }

  async function startedRun(): Promise<{
    mine: MockRunner;
    runId: string;
    dispatchId: string;
    send: (kind: EventKind) => Promise<unknown>;
  }> {
    const mine = await h.pairRunner(team.members.member, "local");
    const task = await seedReadyTask(database.db, project, repoId);
    const run = (
      await client(h.ctx.app, team.members.member.cookie).post<{ id: string }>(
        `/api/tasks/${task.id}/runs`,
        { agent: "claude-code", runnerKind: "local" },
      )
    ).body;
    await h.ctx.services.dispatcher.kick();
    const offer = await mine.next("dispatch_offer");
    mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
    await waitUntil(async () => {
      const ack = await client(h.ctx.app, team.members.member.cookie).get<{ status: string }>(
        `/api/runs/${run.id}`,
      );
      return ack.body.status === "starting";
    });
    return {
      mine,
      runId: run.id,
      dispatchId: offer.dispatch_id,
      send: (kind) => mine.eventAcked(offer.dispatch_id, run.id, kind),
    };
  }

  describe("WebSocket", () => {
    it("訂閱後先重播 afterSeq 之後的 Event，再接上即時串流", async () => {
      const { runId, send } = await startedRun();
      for (let i = 1; i <= 5; i++) await send({ kind: "thought_chunk", text: `${i}` });

      const web = await connectWeb(team.members.viewer.cookie);
      web.subscribe(runId, 2);
      await waitUntil(() => web.events(runId).length === 3);
      expect(web.events(runId)).toEqual([3, 4, 5]);
      const first = web.messages.find((m) => m.type === "run_event");
      expect(
        first?.type === "run_event" && expectContract(PendingRunEvent, first.event),
      ).toMatchObject({
        runId,
        seq: 3,
        event: { kind: "thought_chunk", text: "3" },
      });

      await send({ kind: "thought_chunk", text: "6" });
      await waitUntil(() => web.events(runId).length === 4);
      expect(web.events(runId)).toEqual([3, 4, 5, 6]);
    });

    it("訂閱與寫入同時進行時不漏送也不重複", async () => {
      const { runId, send } = await startedRun();
      await send({ kind: "thought_chunk", text: "0" });
      const web = await connectWeb(team.members.member.cookie);
      // 一邊持續寫入，一邊訂閱。
      const writing = (async () => {
        for (let i = 0; i < 60; i++) await send({ kind: "thought_chunk", text: `${i}` });
      })();
      await new Promise((resolve) => setTimeout(resolve, 20));
      web.subscribe(runId, 0);
      await writing;
      // seq 1 是訂閱前寫入的 "0"，之後 60 筆是 seq 2–61。
      const expected = 61;
      await waitUntil(() => web.events(runId).length === expected, 10_000, "收到所有 Event");
      expect(web.events(runId)).toEqual(Array.from({ length: expected }, (_, i) => i + 1));
    });

    it("缺號時停在缺號之前，補上後才繼續", async () => {
      const { mine, runId, dispatchId } = await startedRun();
      const web = await connectWeb(team.members.member.cookie);
      web.subscribe(runId, 0);
      mine.event(dispatchId, runId, { kind: "thought_chunk", text: "1" }, 1);
      mine.event(dispatchId, runId, { kind: "thought_chunk", text: "3" }, 3);
      await mine.next("event_ack", (a) => a.seq === 1);
      await mine.next("event_ack", (a) => a.seq === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(web.events(runId)).toEqual([1]);
      mine.event(dispatchId, runId, { kind: "thought_chunk", text: "2" }, 2);
      await waitUntil(() => web.events(runId).length === 3);
      expect(web.events(runId)).toEqual([1, 2, 3]);
    });

    it("沒登入或 Origin 不對時拒絕連線", async () => {
      await expect(connectWeb(null)).rejects.toThrow("HTTP 401");
      await expect(connectWeb(team.members.viewer.cookie, "https://evil.example")).rejects.toThrow(
        "HTTP 403",
      );
    });

    it("訂閱其他 Team 的 Run 回錯誤，不送任何 Event", async () => {
      const { runId, send } = await startedRun();
      await send({ kind: "thought_chunk", text: "秘密" });
      const other = await seedTeam(database.db, "Other");
      const web = await connectWeb(other.members.owner.cookie);
      web.subscribe(runId, 0);
      await waitUntil(() => web.messages.length > 0);
      expect(web.messages).toEqual([
        { type: "error", code: "not_found", message: expect.any(String), runId },
      ]);
    });

    it("被移出 Team 後不再收到 Event，連線被關閉", async () => {
      const { runId, send } = await startedRun();
      const web = await connectWeb(team.members.viewer.cookie);
      web.subscribe(runId, 0);
      await send({ kind: "thought_chunk", text: "1" });
      await waitUntil(() => web.events(runId).length >= 1);
      await database.db.delete(members).where(eq(members.id, team.members.viewer.id));
      await send({ kind: "thought_chunk", text: "2" });
      expect(await web.closed).toBe(4401);
      expect(web.events(runId)).not.toContain(2);
    });

    it("格式錯誤的訊息回 invalid_message", async () => {
      const web = await connectWeb(team.members.viewer.cookie);
      web.ws.send("{nope");
      await waitUntil(() => web.messages.length > 0);
      expect(web.messages[0]).toMatchObject({ type: "error", code: "invalid_message" });
    });
  });

  describe("blob", () => {
    function upload(
      runner: MockRunner | { runnerToken: string },
      blobId: string,
      runId: string,
      data: Buffer,
      overrides: { sha256?: string; contentType?: string } = {},
    ) {
      const sha256 = overrides.sha256 ?? createHash("sha256").update(data).digest("hex");
      return h.ctx.app.request(`${RUNNER_BLOB_PATH}/${blobId}?runId=${runId}&sha256=${sha256}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${runner.runnerToken}`,
          "content-type": overrides.contentType ?? "text/plain; charset=utf-8",
        },
        body: data,
      });
    }

    const BLOB_ID = "0192f3a0-0000-7000-8000-0000000000b1";

    it("Runner 上傳後，有權限的人可以下載；重送相同內容視為成功", async () => {
      const { mine, runId } = await startedRun();
      const data = Buffer.from("完整的檔案內容\n");
      const res = await upload(mine, BLOB_ID, runId, data);
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ blobId: BLOB_ID, size: data.byteLength });
      expect((await upload(mine, BLOB_ID, runId, data)).status).toBe(200);

      const download = await h.ctx.app.request(`/api/blobs/${BLOB_ID}`, {
        headers: { cookie: team.members.viewer.cookie },
      });
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer()).toString("utf8")).toBe("完整的檔案內容\n");
      // 非圖片一律以附件下載，避免在 Server 的 origin 上被當成網頁執行。
      expect(download.headers.get("content-type")).toBe("application/octet-stream");
      expect(download.headers.get("content-disposition")).toContain("attachment");
      expect(download.headers.get("x-blob-media-type")).toBe("text/plain; charset=utf-8");
    });

    it("圖片可以直接顯示", async () => {
      const { mine, runId } = await startedRun();
      await upload(mine, BLOB_ID, runId, Buffer.from([0x89, 0x50]), { contentType: "image/png" });
      const download = await h.ctx.app.request(`/api/blobs/${BLOB_ID}`, {
        headers: { cookie: team.members.viewer.cookie },
      });
      expect(download.headers.get("content-type")).toBe("image/png");
      expect(download.headers.get("content-disposition")).toBe("inline");
    });

    it("sha256 不符回 422；同一個 blob_id 不同內容回 409；token 錯誤回 401", async () => {
      const { mine, runId } = await startedRun();
      const data = Buffer.from("a");
      expect((await upload(mine, BLOB_ID, runId, data, { sha256: "0".repeat(64) })).status).toBe(
        422,
      );
      expect((await upload(mine, BLOB_ID, runId, data)).status).toBe(201);
      expect((await upload(mine, BLOB_ID, runId, Buffer.from("b"))).status).toBe(409);
      expect((await upload({ runnerToken: "nope" }, BLOB_ID, runId, data)).status).toBe(401);
    });

    it("超過大小上限回 413，不會寫入", async () => {
      const { mine, runId } = await startedRun();
      const limited = createBlobRoutes(h.ctx.services, { maxBytes: 8 }).runner;
      const data = Buffer.from("0123456789");
      const sha256 = createHash("sha256").update(data).digest("hex");
      // 用 stream 送出，沒有 Content-Length，只能邊讀邊算。
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(data));
          controller.close();
        },
      });
      const res = await limited.request(
        `${RUNNER_BLOB_PATH}/${BLOB_ID}?runId=${runId}&sha256=${sha256}`,
        {
          method: "PUT",
          headers: { authorization: `Bearer ${mine.runnerToken}`, "content-type": "text/plain" },
          body,
          duplex: "half",
        } as RequestInit,
      );
      expect(res.status).toBe(413);
      expect(await database.db.select().from(blobs)).toHaveLength(0);
    });

    it("Runner 不能把 blob 掛在不是自己執行的 Run 上", async () => {
      const { runId } = await startedRun();
      const other = await h.pairRunner(team.members.admin, "local");
      expect((await upload(other, BLOB_ID, runId, Buffer.from("x"))).status).toBe(403);
    });

    it("其他 Team 的人不能下載", async () => {
      const { mine, runId } = await startedRun();
      await upload(mine, BLOB_ID, runId, Buffer.from("x"));
      const other = await seedTeam(database.db, "Other");
      const res = await h.ctx.app.request(`/api/blobs/${BLOB_ID}`, {
        headers: { cookie: other.members.owner.cookie },
      });
      expect(res.status).toBe(404);
    });

    it("90 天後清理工作刪除 blob，下載回 410", async () => {
      const { mine, runId } = await startedRun();
      await upload(mine, BLOB_ID, runId, Buffer.from("x"));
      const store = h.ctx.services.blobStore as MemoryBlobStore;
      expect(store.data.size).toBe(1);
      h.ctx.clock.advance(BLOB_RETENTION_MS - 1);
      expect(await h.ctx.services.blobCleanup.runOnce()).toBe(0);
      h.ctx.clock.advance(1);
      const res = await h.ctx.app.request(`/api/blobs/${BLOB_ID}`, {
        headers: { cookie: team.members.viewer.cookie },
      });
      expect(res.status).toBe(410);
      expect(await h.ctx.services.blobCleanup.runOnce()).toBe(1);
      expect(store.data.size).toBe(0);
      expect(await database.db.select().from(blobs)).toHaveLength(0);
    });

    it("檔案系統的 BlobStore 可以寫入、讀取、刪除，拒絕不合法的 key", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), `${NAMES.productSlug}-blobs-`));
      try {
        const store = new FileSystemBlobStore(dir);
        const key = blobStorageKey(BLOB_ID, "a".repeat(64));
        await store.put(key, Buffer.from("內容"));
        expect(Buffer.from((await store.get(key)) ?? []).toString("utf8")).toBe("內容");
        await store.delete(key);
        expect(await store.get(key)).toBeNull();
        await expect(store.put("../escape", Buffer.from("x"))).rejects.toThrow("不合法的 blob key");
        const cleanup = new BlobCleanup(database.db, store, h.ctx.clock, h.ctx.logger);
        expect(await cleanup.runOnce()).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
