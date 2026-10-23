// 通知系統（ARCHITECTURE §12.3）：勿擾時段、依事件類型關閉、Channel。

import { randomUUID } from "node:crypto";
import {
  API_ROUTES,
  NotificationDesktopFeed,
  NotificationListResponse,
  NotificationPreferences,
  NotificationUnreadCount,
  type Role,
  WebServerMessage,
} from "@orbis/api-contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { notificationNotifier } from "../src/github/app";
import {
  isInQuietHours,
  isValidTimeZone,
  localMinuteOfDay,
} from "../src/notifications/quiet-hours";
import type { NotifyRequest } from "../src/notifications/types";
import { expectContract, resetDatabase, seedReadyTask } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import {
  AWAITING_REVIEW,
  type Flow,
  openGate,
  RUN_DIFF,
  startFlow,
  startRun,
} from "./helpers/flow";
import { waitUntil } from "./helpers/runner-harness";

const at = (iso: string) => new Date(iso);

describe("勿擾時段", () => {
  it("以本人的時區計算當地時間", () => {
    // 2026-10-23T14:30Z 是台北的 22:30、紐約（夏令時間）的 10:30。
    expect(localMinuteOfDay(at("2026-10-23T14:30:00Z"), "Asia/Taipei")).toBe(22 * 60 + 30);
    expect(localMinuteOfDay(at("2026-10-23T14:30:00Z"), "America/New_York")).toBe(10 * 60 + 30);
  });

  it("同一天內的時段：含開始、不含結束", () => {
    const quiet = { startMinute: 12 * 60, endMinute: 13 * 60, timeZone: "UTC" };
    expect(isInQuietHours(at("2026-10-23T11:59:00Z"), quiet)).toBe(false);
    expect(isInQuietHours(at("2026-10-23T12:00:00Z"), quiet)).toBe(true);
    expect(isInQuietHours(at("2026-10-23T12:59:00Z"), quiet)).toBe(true);
    expect(isInQuietHours(at("2026-10-23T13:00:00Z"), quiet)).toBe(false);
  });

  it("跨午夜的時段（22:00–07:00，台北）", () => {
    const quiet = { startMinute: 22 * 60, endMinute: 7 * 60, timeZone: "Asia/Taipei" };
    expect(isInQuietHours(at("2026-10-23T13:59:00Z"), quiet)).toBe(false); // 21:59
    expect(isInQuietHours(at("2026-10-23T14:00:00Z"), quiet)).toBe(true); // 22:00
    expect(isInQuietHours(at("2026-10-23T18:00:00Z"), quiet)).toBe(true); // 02:00
    expect(isInQuietHours(at("2026-10-23T22:59:00Z"), quiet)).toBe(true); // 06:59
    expect(isInQuietHours(at("2026-10-23T23:00:00Z"), quiet)).toBe(false); // 07:00
  });

  it("沒有設定、或開始與結束相同時不算勿擾", () => {
    expect(isInQuietHours(at("2026-10-23T12:00:00Z"), null)).toBe(false);
    expect(
      isInQuietHours(at("2026-10-23T12:00:00Z"), {
        startMinute: 600,
        endMinute: 600,
        timeZone: "UTC",
      }),
    ).toBe(false);
  });

  it("檢查時區名稱", () => {
    expect(isValidTimeZone("Asia/Taipei")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});

describe.skipIf(dbSkipReason !== null)("通知系統", () => {
  let database: TestDatabase;
  let flow: Flow;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    flow = await startFlow(database.db);
  });

  afterEach(async () => {
    await flow.close();
  });

  const list = async (role: Role) =>
    expectContract(NotificationListResponse, (await flow.as(role).get("/api/notifications")).body)
      .items;

  /** 直接發一則通知給 Member（不經過其他流程）。 */
  const notify = (memberIds: string[], extra: Partial<NotifyRequest> = {}) =>
    flow.h.ctx.services.notify.notify(null, {
      kind: "mentioned",
      recipients: memberIds,
      taskId: null,
      title: "有人提到你",
      ...extra,
    });

  describe("事件", () => {
    it("Gate 等待核准：通知負責人；Task 被退回時通知負責人（操作者本人不通知自己）", async () => {
      const { admin, member } = flow.team.members;
      const started = await startRun(flow, {
        task: { assigneeMemberId: admin.id },
        criteria: [{ kind: "manual", description: "看過" }],
      });
      await started.send(RUN_DIFF);
      await started.send(AWAITING_REVIEW);
      const gate = await openGate(flow, started.task.id);
      expect(await list("admin")).toMatchObject([
        {
          kind: "gate_pending",
          taskKey: started.task.key,
          gateId: gate.id,
          url: `/tasks/${started.task.key}`,
        },
      ]);
      await flow.as("member").post(`/api/gates/${gate.id}/decision`, {
        action: "reject",
        comment: "再改一下",
      });
      expect((await list("admin")).map((n) => n.kind)).toEqual(["task_rejected", "gate_pending"]);
      expect(await list("member")).toEqual([]);
      expect(member.id).not.toBe(admin.id);
    });

    it("被指派 Task 時通知新的負責人；指派給自己不通知", async () => {
      const task = await seedReadyTask(database.db, flow.project, flow.repoId);
      await flow.as("member").patch(`/api/tasks/${task.id}`, {
        assigneeMemberId: flow.team.members.admin.id,
      });
      await waitUntil(async () => (await list("admin")).length === 1, 5000, "通知");
      expect((await list("admin"))[0]).toMatchObject({
        kind: "task_assigned",
        actorMemberId: flow.team.members.member.id,
      });
      await flow.as("member").patch(`/api/tasks/${task.id}`, {
        assigneeMemberId: flow.team.members.member.id,
      });
      expect(await list("member")).toEqual([]);
    });

    it("權限請求通知 Local Runner 的擁有者", async () => {
      const started = await startRun(flow);
      await started.send({
        kind: "permission_request",
        request_id: "req-1",
        tool_call_id: null,
        title: "執行 rm -rf build",
        options: [{ option_id: "allow", name: "允許", kind: "allow_once" }],
        purpose: "tool",
      });
      expect(await list("member")).toMatchObject([
        { kind: "permission_request", body: "執行 rm -rf build", runId: started.run.id },
      ]);
      expect(await list("admin")).toEqual([]);
    });

    it("設定的信任核准通知 Project 的 Admin 以上", async () => {
      const started = await startRun(flow);
      await started.send({
        kind: "permission_request",
        request_id: "req-2",
        tool_call_id: null,
        title: "信任 Repo 設定檔",
        options: [{ option_id: "trust", name: "信任", kind: "allow_once" }],
        purpose: "config_trust",
      });
      expect((await list("admin")).map((n) => n.kind)).toEqual(["permission_request"]);
      expect((await list("owner")).map((n) => n.kind)).toEqual(["permission_request"]);
      expect(await list("member")).toEqual([]);
    });

    it("GitHub 整合：PR merge → task_merged，PR 沒 merge 就關閉 → task_rejected，開 PR 失敗不重複通知", async () => {
      const sent: NotifyRequest[] = [];
      const notifier = notificationNotifier(
        { notify: async (_uow, request) => void sent.push(request) },
        flow.h.ctx.logger,
      );
      const base = { memberId: flow.team.members.member.id, taskId: randomUUID(), message: "m" };
      await notifier.notify({ ...base, kind: "pr_merged", url: "https://github.com/a/b/pull/1" });
      await notifier.notify({ ...base, kind: "pr_closed_unmerged" });
      await notifier.notify({ ...base, kind: "pr_open_failed" });
      expect(sent.map((s) => s.kind)).toEqual(["task_merged", "task_rejected"]);
    });
  });

  describe("個人設定", () => {
    it("關閉的事件類型兩個 Channel 都不送（不建立通知）", async () => {
      const { member } = flow.team.members;
      const put = await flow.as("member").put("/api/notification-preferences", {
        disabledKinds: ["mentioned"],
        quietHours: null,
      });
      expect(put.status).toBe(200);
      await notify([member.id]);
      await notify([member.id], { kind: "task_assigned", title: "指派" });
      expect((await list("member")).map((n) => n.kind)).toEqual(["task_assigned"]);
    });

    it("勿擾時段只壓住桌面推送：App 內照常記錄，桌面 feed 不出現", async () => {
      const { member } = flow.team.members;
      // 測試的時鐘是 2026-10-23T08:00Z，也就是台北的 16:00。
      await flow.as("member").put("/api/notification-preferences", {
        disabledKinds: [],
        quietHours: { start: "15:00", end: "17:00", timeZone: "Asia/Taipei" },
      });
      const baseline = expectContract(
        NotificationDesktopFeed,
        (await flow.as("member").get("/api/notifications/desktop-feed")).body,
      );
      await notify([member.id], { title: "勿擾中" });
      expect((await list("member")).map((n) => n.title)).toEqual(["勿擾中"]);
      const during = expectContract(
        NotificationDesktopFeed,
        (await flow.as("member").get(`/api/notifications/desktop-feed?after=${baseline.cursor}`))
          .body,
      );
      expect(during.items).toEqual([]);

      // 勿擾結束後的通知照常推送，勿擾中那則不補推。
      flow.h.ctx.clock.advance(2 * 60 * 60 * 1000);
      await notify([member.id], { title: "勿擾結束" });
      const after = expectContract(
        NotificationDesktopFeed,
        (await flow.as("member").get(`/api/notifications/desktop-feed?after=${during.cursor}`))
          .body,
      );
      expect(after.items.map((n) => n.title)).toEqual(["勿擾結束"]);
    });

    it("設定的讀取與驗證", async () => {
      const initial = expectContract(
        NotificationPreferences,
        (await flow.as("member").get("/api/notification-preferences")).body,
      );
      expect(initial).toEqual({ disabledKinds: [], quietHours: null });
      const saved = await flow.as("member").put("/api/notification-preferences", {
        disabledKinds: ["gate_pending", "gate_pending"],
        quietHours: { start: "22:00", end: "07:30", timeZone: "Asia/Taipei" },
      });
      expect(saved.body).toEqual({
        disabledKinds: ["gate_pending"],
        quietHours: { start: "22:00", end: "07:30", timeZone: "Asia/Taipei" },
      });
      const bad = await flow.as("member").put("/api/notification-preferences", {
        disabledKinds: [],
        quietHours: { start: "22:00", end: "07:00", timeZone: "Mars/Olympus" },
      });
      expect(bad.status).toBe(400);
    });
  });

  describe("通知中心與桌面 feed", () => {
    it("只看得到自己的通知；未讀數、標為已讀（指定或全部）", async () => {
      const { member, admin } = flow.team.members;
      await notify([member.id], { title: "一" });
      await notify([member.id], { title: "二" });
      await notify([admin.id], { title: "給 Admin" });
      const items = await list("member");
      expect(items.map((n) => n.title)).toEqual(["二", "一"]);
      const unread = async () =>
        expectContract(
          NotificationUnreadCount,
          (await flow.as("member").get("/api/notifications/unread-count")).body,
        ).count;
      expect(await unread()).toBe(2);
      await flow.as("member").post("/api/notifications/read", { ids: [items[0]?.id] });
      expect(await unread()).toBe(1);
      // 別人的通知 id 不會被標成已讀。
      const adminItems = await list("admin");
      await flow.as("member").post("/api/notifications/read", { ids: [adminItems[0]?.id] });
      expect((await list("admin"))[0]?.readAt).toBeNull();
      await flow.as("member").post("/api/notifications/read", { all: true });
      expect(await unread()).toBe(0);
    });

    it("分頁：nextBefore 取得更舊的通知", async () => {
      const { member } = flow.team.members;
      for (let i = 1; i <= 3; i++) await notify([member.id], { title: `第 ${i} 則` });
      const first = expectContract(
        NotificationListResponse,
        (await flow.as("member").get("/api/notifications?limit=2")).body,
      );
      expect(first.items.map((n) => n.title)).toEqual(["第 3 則", "第 2 則"]);
      const second = expectContract(
        NotificationListResponse,
        (await flow.as("member").get(`/api/notifications?limit=2&before=${first.nextBefore}`)).body,
      );
      expect(second).toMatchObject({ items: [{ title: "第 1 則" }], nextBefore: null });
    });

    it("桌面 feed：第一次只拿基準 cursor，之後只回新的通知", async () => {
      const { member } = flow.team.members;
      await notify([member.id], { title: "舊的" });
      const first = expectContract(
        NotificationDesktopFeed,
        (await flow.as("member").get("/api/notifications/desktop-feed")).body,
      );
      expect(first.items).toEqual([]);
      await notify([member.id], { title: "新的" });
      const next = expectContract(
        NotificationDesktopFeed,
        (await flow.as("member").get(`/api/notifications/desktop-feed?after=${first.cursor}`)).body,
      );
      expect(next.items.map((n) => n.title)).toEqual(["新的"]);
      const again = expectContract(
        NotificationDesktopFeed,
        (await flow.as("member").get(`/api/notifications/desktop-feed?after=${next.cursor}`)).body,
      );
      expect(again.items).toEqual([]);
    });

    it("Web 經由 /api/ws 即時收到自己的通知", async () => {
      const { member, admin } = flow.team.members;
      const ws = new WebSocket(`ws://127.0.0.1:${flow.h.server.port}${API_ROUTES.ws}`, {
        headers: { cookie: member.cookie, origin: "http://localhost:5173" },
      });
      const received: unknown[] = [];
      ws.on("message", (data) => received.push(JSON.parse(data.toString())));
      await new Promise((resolve) => ws.once("open", resolve));
      await notify([admin.id], { title: "不是給你的" });
      await notify([member.id], { title: "即時" });
      await waitUntil(() => received.length > 0, 5000, "收到推送");
      ws.close();
      expect(received).toHaveLength(1);
      expect(expectContract(WebServerMessage, received[0])).toMatchObject({
        type: "notification",
        notification: { title: "即時" },
      });
    });
  });
});
