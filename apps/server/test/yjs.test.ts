// 共同編輯（Yjs、y-websocket 協定）：兩個 client 同時編輯後內容一致、在線狀態、權限、
// 重新啟動 Server 後內容仍在。

import { COLLAB_FRAGMENT } from "@orbis/api-contract";
import { eq } from "drizzle-orm";
import * as encoding from "lib0/encoding";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { collabDocRef, parseCollabDocRef } from "../src/collab/doc-name";
import { COLLAB_PATH_PREFIX } from "../src/collab/endpoint";
import { fragmentToMarkdown, replaceFragmentWithMarkdown } from "../src/collab/markdown";
import { PostgresCollabStore } from "../src/collab/store";
import {
  acceptanceCriteria,
  projectMemberRoles,
  repoSpecs,
  sessions,
  tasks,
} from "../src/db/schema";
import { type RunningServer, startServer } from "../src/server";
import {
  client,
  createTestContext,
  resetDatabase,
  type SeededMember,
  type SeededTeam,
  seedProject,
  seedReadyTask,
  seedTeam,
  type TestContext,
  unusedGitHubOAuth,
} from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import { waitUntil } from "./helpers/runner-harness";

const ORIGIN = "http://localhost:5173";

describe.skipIf(dbSkipReason !== null)("共同編輯（Yjs）", () => {
  let database: TestDatabase;
  let store: PostgresCollabStore;
  let server: RunningServer;
  let team: SeededTeam;
  let taskId: string;
  const providers: WebsocketProvider[] = [];

  let ctx: TestContext;

  async function start(): Promise<RunningServer> {
    ctx = createTestContext(database.db, { collabStore: store, collabPersistDebounceMs: 20 });
    return startServer({
      config: {
        port: 0,
        publicUrl: ORIGIN,
        bootstrapOwnerGithubUserId: null,
        devPairingToken: null,
        runnerHeartbeatIntervalMs: 15_000,
      },
      db: database.db,
      logger: ctx.logger,
      githubOAuth: unusedGitHubOAuth,
      services: ctx.services,
      dispatcherIntervalMs: 0,
      collabAuthzRecheckMs: 50,
    });
  }

  /** 以某位 Member 的 session 連上文件（不自動重連，方便確認關閉的原因）。 */
  function connect(
    member: SeededMember | null,
    docName: string,
    options: { origin?: string } = {},
  ): { doc: Y.Doc; provider: WebsocketProvider; closed: Promise<number> } {
    const headers: Record<string, string> = { origin: options.origin ?? ORIGIN };
    if (member) headers.cookie = member.cookie;
    let resolveClosed: (code: number) => void = () => {};
    const closed = new Promise<number>((resolve) => {
      resolveClosed = resolve;
    });
    class AuthenticatedWebSocket extends WebSocket {
      constructor(url: string | URL) {
        super(url, { headers });
        this.on("close", (code) => resolveClosed(code));
        this.on("unexpected-response", (_req, res) => resolveClosed(res.statusCode ?? 0));
      }
    }
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(
      `ws://127.0.0.1:${server.port}${COLLAB_PATH_PREFIX.replace(/\/$/, "")}`,
      docName,
      doc,
      {
        WebSocketPolyfill: AuthenticatedWebSocket as unknown as typeof globalThis.WebSocket,
        maxBackoffTime: 60_000,
        disableBc: true,
      },
    );
    providers.push(provider);
    return { doc, provider, closed };
  }

  const synced = (provider: WebsocketProvider) =>
    waitUntil(() => provider.synced, 5000, "y-websocket 同步完成");
  const text = (doc: Y.Doc) => doc.getText("content").toString();
  /** 資料庫中的快照（collab_documents）。 */
  const snapshot = (name: string) => {
    const ref = parseCollabDocRef(name);
    if (!ref) throw new Error(`文件名稱不合法：${name}`);
    return store.load(ref);
  };

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    store = new PostgresCollabStore(database.db);
    server = await start();
    team = await seedTeam(database.db);
    const { project, repo } = await seedProject(database.db, team.teamId);
    taskId = (await seedReadyTask(database.db, project, repo.id)).id;
  });

  afterEach(async () => {
    for (const provider of providers.splice(0)) provider.destroy();
    await server.close();
  });

  it("兩個 client 同時編輯後內容一致", async () => {
    const name = collabDocRef("task-description", taskId).name;
    const a = connect(team.members.member, name);
    const b = connect(team.members.admin, name);
    await Promise.all([synced(a.provider), synced(b.provider)]);

    // 兩邊在還沒收到對方的修改前各自編輯。
    a.doc.getText("content").insert(0, "Alice 的段落。");
    b.doc.getText("content").insert(0, "Bob 的段落。");
    for (let i = 0; i < 20; i++) {
      a.doc.getText("content").insert(a.doc.getText("content").length, `a${i}`);
      b.doc.getText("content").insert(0, `b${i}`);
    }
    await waitUntil(() => text(a.doc) === text(b.doc) && text(a.doc).length > 0, 5000, "內容一致");
    expect(text(a.doc)).toContain("Alice 的段落。");
    expect(text(a.doc)).toContain("Bob 的段落。");
    expect(text(a.doc)).toContain("a19");
    expect(text(a.doc)).toContain("b19");

    // 第三個 client 之後才連上，也拿到同樣的內容。
    const c = connect(team.members.owner, name);
    await synced(c.provider);
    await waitUntil(() => text(c.doc) === text(a.doc), 5000, "後來的 client 同步");
  });

  it("在線狀態（awareness）：看得到其他人，斷線後移除", async () => {
    const name = collabDocRef("task-description", taskId).name;
    const a = connect(team.members.member, name);
    const b = connect(team.members.admin, name);
    await Promise.all([synced(a.provider), synced(b.provider)]);
    a.provider.awareness.setLocalStateField("user", { name: "Alice" });
    await waitUntil(
      () => b.provider.awareness.getStates().get(a.doc.clientID)?.user?.name === "Alice",
      5000,
      "看到 Alice",
    );
    a.provider.destroy();
    await waitUntil(
      () => !b.provider.awareness.getStates().has(a.doc.clientID),
      5000,
      "Alice 離線後移除",
    );
  });

  it("在線狀態不能冒用別人的 client id，memberId 由 Server 填入", async () => {
    const name = collabDocRef("task-description", taskId).name;
    const a = connect(team.members.member, name);
    const b = connect(team.members.admin, name);
    const c = connect(team.members.owner, name);
    await Promise.all([synced(a.provider), synced(b.provider), synced(c.provider)]);
    a.provider.awareness.setLocalStateField("user", { name: "Alice" });
    // b 自稱是 Owner，還想冒用 a 的 client id。
    b.provider.awareness.setLocalState({ user: { name: "Bob" }, memberId: team.members.owner.id });
    await waitUntil(
      () =>
        c.provider.awareness.getStates().get(a.doc.clientID)?.user?.name === "Alice" &&
        c.provider.awareness.getStates().get(b.doc.clientID)?.user?.name === "Bob",
      5000,
      "看到 Alice 與 Bob",
    );
    expect(c.provider.awareness.getStates().get(a.doc.clientID)?.memberId).toBe(
      team.members.member.id,
    );
    expect(c.provider.awareness.getStates().get(b.doc.clientID)?.memberId).toBe(
      team.members.admin.id,
    );

    const forgedDoc = new Y.Doc();
    forgedDoc.clientID = a.doc.clientID;
    const forged = new awarenessProtocol.Awareness(forgedDoc);
    forged.setLocalState({ user: { name: "冒充的 Alice" } });
    // 讓 clock 比 a 的大，確保不是因為 clock 較舊才被忽略。
    for (let i = 0; i < 5; i++) forged.setLocalState({ user: { name: "冒充的 Alice" }, i });
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(forged, [a.doc.clientID]),
    );
    b.provider.ws?.send(encoding.toUint8Array(encoder));
    b.provider.awareness.setLocalStateField("user", { name: "Bob 2" });
    await waitUntil(
      () => c.provider.awareness.getStates().get(b.doc.clientID)?.user?.name === "Bob 2",
      5000,
      "b 的下一個狀態",
    );
    expect(c.provider.awareness.getStates().get(a.doc.clientID)?.user?.name).toBe("Alice");
    forged.destroy();
  });

  it("重新啟動 Server 後內容仍在", async () => {
    const name = collabDocRef("task-description", taskId).name;
    const a = connect(team.members.member, name);
    await synced(a.provider);
    a.doc.getText("content").insert(0, "重啟前的內容");
    await waitUntil(
      async () => {
        const state = await snapshot(name);
        if (!state) return false;
        const saved = new Y.Doc();
        Y.applyUpdate(saved, state);
        return text(saved) === "重啟前的內容";
      },
      5000,
      "寫回快照",
    );
    a.provider.destroy();
    await server.close();

    server = await start();
    const b = connect(team.members.admin, name);
    await synced(b.provider);
    await waitUntil(() => text(b.doc) === "重啟前的內容", 5000, "重啟後讀回內容");
  });

  it("最後一個 client 離開後寫回並卸載文件", async () => {
    const name = collabDocRef("task-description", taskId).name;
    const a = connect(team.members.member, name);
    await synced(a.provider);
    const b = connect(team.members.admin, name);
    await synced(b.provider);
    a.doc.getText("content").insert(0, "x");
    // 另一個 client 收到修改，表示 Server 已經套用。
    await waitUntil(() => text(b.doc) === "x", 5000, "Server 收到修改");
    expect(server.services.collab.openDocumentCount).toBe(1);
    a.provider.destroy();
    b.provider.destroy();
    await waitUntil(() => server.services.collab.openDocumentCount === 0, 5000, "卸載文件");
    const saved = await snapshot(name);
    if (!saved) throw new Error("沒有快照");
    const restored = new Y.Doc();
    Y.applyUpdate(restored, saved);
    expect(text(restored)).toBe("x");
  });

  it("Viewer 可以讀，但修改不會被套用", async () => {
    const name = collabDocRef("task-description", taskId).name;
    const editor = connect(team.members.member, name);
    await synced(editor.provider);
    editor.doc.getText("content").insert(0, "原文");
    const viewer = connect(team.members.viewer, name);
    await synced(viewer.provider);
    await waitUntil(() => text(viewer.doc) === "原文", 5000, "Viewer 讀到內容");

    viewer.doc.getText("content").insert(0, "Viewer 偷改");
    editor.doc.getText("content").insert(2, "之後");
    await waitUntil(() => text(viewer.doc).includes("之後"), 5000, "Viewer 收到之後的修改");
    // 給 Server 時間處理 Viewer 送來的 update，再確認沒有被套用。
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(text(editor.doc)).toBe("原文之後");
  });

  it("沒有登入、別的 Team、Origin 不對、文件名稱不合法時拒絕連線", async () => {
    const name = collabDocRef("task-description", taskId).name;
    expect(await connect(null, name).closed).toBe(401);
    expect(
      await connect(team.members.member, name, { origin: "https://evil.example" }).closed,
    ).toBe(403);
    const other = await seedTeam(database.db, "Other");
    expect(await connect(other.members.owner, name).closed).toBe(404);
    expect(await connect(team.members.member, "task-description:not-a-uuid").closed).toBe(404);
    expect(await connect(team.members.member, `unknown:${taskId}`).closed).toBe(404);
  });

  it("Acceptance Criterion 與 Repo Spec 草稿的文件沿用所屬 Task／Project 的權限", async () => {
    const [criterion] = await database.db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.taskId, taskId));
    if (!criterion) throw new Error("沒有 Acceptance Criterion");
    const ac = connect(
      team.members.member,
      collabDocRef("acceptance-criterion", criterion.id).name,
    );
    await synced(ac.provider);

    const { repo } = await seedProject(database.db, team.teamId, { taskKeyPrefix: "SPEC" });
    const [spec] = await database.db
      .insert(repoSpecs)
      .values({ repoId: repo.id, path: "docs/spec.md" })
      .returning();
    if (!spec) throw new Error("建立 Repo Spec 失敗");
    const draft = connect(team.members.member, collabDocRef("repo-spec-draft", spec.id).name);
    await synced(draft.provider);
    const other = await seedTeam(database.db, "Other");
    expect(
      await connect(other.members.owner, collabDocRef("repo-spec-draft", spec.id).name).closed,
    ).toBe(404);
  });

  it("連線期間 session 失效時以 4401 關閉；Role 降為 Viewer 後改成唯讀", async () => {
    const name = collabDocRef("task-description", taskId).name;
    const owner = connect(team.members.owner, name);
    const member = connect(team.members.member, name);
    await Promise.all([synced(owner.provider), synced(member.provider)]);

    // Project 把 Member 覆寫成 Viewer：之後的修改不會被套用。
    const [task] = await database.db.select().from(tasks).where(eq(tasks.id, taskId));
    if (!task) throw new Error("Task 不存在");
    await database.db
      .insert(projectMemberRoles)
      .values({ projectId: task.projectId, memberId: team.members.member.id, role: "viewer" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    member.doc.getText("content").insert(0, "降級後的修改");
    owner.doc.getText("content").insert(0, "Owner");
    await waitUntil(() => text(member.doc).includes("Owner"), 5000, "仍收得到修改");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(text(owner.doc)).toBe("Owner");

    // session 被刪除（登出）：連線以 4401 關閉。
    await database.db
      .delete(sessions)
      .where(eq(sessions.githubUserId, team.members.owner.githubUserId));
    expect(await owner.closed).toBe(4401);
  });

  describe("與資料庫的內容同步", () => {
    const markdownOf = (doc: Y.Doc) => fragmentToMarkdown(doc.getXmlFragment(COLLAB_FRAGMENT));
    const description = async () =>
      (await database.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.description;

    it("第一次開啟時以 Task 描述建立文件，並立刻保存快照", async () => {
      const name = collabDocRef("task-description", taskId).name;
      const a = connect(team.members.member, name);
      await synced(a.provider);
      await waitUntil(() => markdownOf(a.doc) === "用 GitHub 登入", 5000, "讀到描述");
      expect(await snapshot(name)).not.toBeNull();
    });

    it("編輯後回寫 Task 描述，並發出 task.updated（source = collab）", async () => {
      const seen: string[] = [];
      server.services.events.subscribe((event) => {
        if (event.type === "task.updated" && event.taskId === taskId) seen.push(event.source);
      });
      const a = connect(team.members.member, collabDocRef("task-description", taskId).name);
      await synced(a.provider);
      await waitUntil(() => markdownOf(a.doc) !== "", 5000, "讀到描述");
      replaceFragmentWithMarkdown(a.doc.getXmlFragment(COLLAB_FRAGMENT), "## 新的描述\n\n- 第一點");
      await waitUntil(
        async () => (await description()) === "## 新的描述\n\n- 第一點",
        5000,
        "回寫描述",
      );
      expect(seen).toEqual(["collab"]);
    });

    it("描述被 REST 改掉時，連上的 client 立刻看到新的內容（不會再回寫一次）", async () => {
      const seen: string[] = [];
      server.services.events.subscribe((event) => {
        if (event.type === "task.updated" && event.taskId === taskId) seen.push(event.source);
      });
      const a = connect(team.members.member, collabDocRef("task-description", taskId).name);
      await synced(a.provider);
      await waitUntil(() => markdownOf(a.doc) !== "", 5000, "讀到描述");
      const res = await client(ctx.app, team.members.admin.cookie).patch(`/api/tasks/${taskId}`, {
        description: "REST 改的 **描述**",
      });
      expect(res.status).toBe(200);
      await waitUntil(() => markdownOf(a.doc) === "REST 改的 **描述**", 5000, "client 看到新描述");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(seen).toEqual(["api"]);
      expect(await description()).toBe("REST 改的 **描述**");
    });

    it("文件沒有載入時，描述的修改寫進快照；下次開啟看到新的內容", async () => {
      const name = collabDocRef("task-description", taskId).name;
      const a = connect(team.members.member, name);
      await synced(a.provider);
      await waitUntil(() => markdownOf(a.doc) !== "", 5000, "讀到描述");
      a.provider.destroy();
      await waitUntil(() => server.services.collab.openDocumentCount === 0, 5000, "卸載文件");

      await client(ctx.app, team.members.admin.cookie).patch(`/api/tasks/${taskId}`, {
        description: "離線時改的",
      });
      const b = connect(team.members.member, name);
      await synced(b.provider);
      await waitUntil(() => markdownOf(b.doc) === "離線時改的", 5000, "看到新的描述");
    });

    it("Acceptance Criterion：以描述建立文件、編輯後回寫、REST 修改時同步", async () => {
      const [criterion] = await database.db
        .select()
        .from(acceptanceCriteria)
        .where(eq(acceptanceCriteria.taskId, taskId));
      if (!criterion) throw new Error("沒有 Acceptance Criterion");
      const a = connect(
        team.members.member,
        collabDocRef("acceptance-criterion", criterion.id).name,
      );
      await synced(a.provider);
      await waitUntil(() => markdownOf(a.doc) === "測試通過", 5000, "讀到描述");

      replaceFragmentWithMarkdown(a.doc.getXmlFragment(COLLAB_FRAGMENT), "所有測試通過");
      const current = async () =>
        (
          await database.db
            .select()
            .from(acceptanceCriteria)
            .where(eq(acceptanceCriteria.id, criterion.id))
        )[0]?.description;
      await waitUntil(async () => (await current()) === "所有測試通過", 5000, "回寫描述");

      const res = await client(ctx.app, team.members.admin.cookie).patch(
        `/api/acceptance-criteria/${criterion.id}`,
        { description: "lint 與測試通過" },
      );
      expect(res.status).toBe(200);
      await waitUntil(() => markdownOf(a.doc) === "lint 與測試通過", 5000, "client 看到新描述");

      // 清空文件時保留原本的描述（Acceptance Criterion 的描述不可以是空的）。
      replaceFragmentWithMarkdown(a.doc.getXmlFragment(COLLAB_FRAGMENT), "");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await current()).toBe("lint 與測試通過");
    });
  });
});
