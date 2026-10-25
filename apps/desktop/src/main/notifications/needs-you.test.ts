import type { NeedsYouItem } from "@orbis/api-contract";
import { afterEach, describe, expect, it } from "vitest";
import { NeedsYouPoller, needsYouHref, needsYouNotification } from "./needs-you";

const base = {
  memberId: "m1",
  taskId: "t1",
  taskKey: "ORB-12",
  runId: "r1",
  createdAt: "2026-10-23T00:00:00.000Z",
};
const permission: NeedsYouItem = {
  ...base,
  id: "n1",
  kind: "permission_request",
  permissionRequestId: "p1",
  toolCallId: null,
  purpose: "tool",
  title: "執行 pnpm test",
  options: [{ optionId: "allow", name: "允許", kind: "allow_once" }],
};
const gate: NeedsYouItem = { ...base, id: "n2", kind: "gate", gateKind: "review" };
const stopped: NeedsYouItem = {
  ...base,
  id: "n3",
  kind: "stopped_run",
  reasonCode: "verification_limit",
  attempt: 3,
  detail: null,
};

describe("needsYouNotification", () => {
  it("依項目種類產生通知文字與網址", () => {
    expect(needsYouNotification(permission)).toEqual({
      title: "ORB-12 需要你核准權限",
      body: "執行 pnpm test",
      href: "/runs/r1?focus=permission-p1",
    });
    expect(needsYouNotification(gate).title).toBe("ORB-12 的 Review Gate 等待核准");
    expect(needsYouNotification({ ...gate, gateKind: "plan" }).title).toBe(
      "ORB-12 的 Plan Gate 等待核准",
    );
    expect(needsYouNotification(stopped)).toMatchObject({
      title: "ORB-12 的 Run 停下來了",
      body: "Verification 連續失敗 3 次",
    });
  });

  it("Review Gate 到 diff review，Plan Gate 到 Run 頁，停下來的 Run 到 Verification 分頁，網址中的 ID 會編碼", () => {
    expect(needsYouHref(gate)).toBe("/runs/r1/review");
    expect(needsYouHref({ ...gate, gateKind: "plan" })).toBe("/runs/r1");
    expect(needsYouHref(stopped)).toBe("/runs/r1?tab=verification");
    expect(needsYouHref({ ...gate, gateKind: "plan", runId: "a/b?c" })).toBe("/runs/a%2Fb%3Fc");
  });
});

describe("NeedsYouPoller", () => {
  const pollers: NeedsYouPoller[] = [];
  afterEach(() => {
    for (const p of pollers.splice(0)) p.stop();
  });

  function setup(responses: (NeedsYouItem[] | Error)[]) {
    const calls: { items: string[]; newItems: string[] }[] = [];
    const errors: unknown[] = [];
    let index = 0;
    const poller = new NeedsYouPoller({
      list: async () => {
        const response = responses[Math.min(index, responses.length - 1)] ?? [];
        index += 1;
        if (response instanceof Error) throw response;
        return response;
      },
      onItems: (items, newItems) =>
        calls.push({ items: items.map((i) => i.id), newItems: newItems.map((i) => i.id) }),
      onError: (error) => errors.push(error),
      intervalMs: 10,
    });
    pollers.push(poller);
    return { poller, calls, errors };
  }

  const waitUntil = async (check: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("等待逾時");
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  it("第一次輪詢只建立基準；之後只回報新出現的項目，同一個項目不重複", async () => {
    const { poller, calls } = setup([[permission], [permission, gate], [gate], [gate, stopped]]);
    poller.start();
    await waitUntil(() => calls.length >= 4);
    expect(calls.slice(0, 4)).toEqual([
      { items: ["n1"], newItems: [] },
      { items: ["n1", "n2"], newItems: ["n2"] },
      { items: ["n2"], newItems: [] },
      { items: ["n2", "n3"], newItems: ["n3"] },
    ]);
  });

  it("輪詢失敗時回報錯誤並繼續，不會把舊項目當成新項目", async () => {
    const { poller, calls, errors } = setup([[gate], new Error("HTTP 502"), [gate, stopped]]);
    poller.start();
    await waitUntil(() => calls.length >= 2);
    expect(errors).toHaveLength(1);
    expect(calls[1]).toEqual({ items: ["n2", "n3"], newItems: ["n3"] });
  });

  it("stop() 之後重新 start() 會重新建立基準", async () => {
    const { poller, calls } = setup([[gate]]);
    poller.start();
    await waitUntil(() => calls.length >= 1);
    poller.stop();
    const before = calls.length;
    poller.start();
    await waitUntil(() => calls.length > before);
    expect(calls[before]).toEqual({ items: ["n2"], newItems: [] });
  });
});
