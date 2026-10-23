// webhook 入口：簽章驗證、delivery ID 去重、失敗與 redelivery、Hono 路由。

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createGitHubWebhookRoutes } from "../src/routes";
import { DELIVERY_STALE_AFTER_MS } from "../src/webhook/handler";
import { signWebhookBody, verifyWebhookSignature } from "../src/webhook/verify";
import { createWorld, fixture, WEBHOOK_SECRET, type World } from "./helpers/world";

function rawRequest(
  body: string,
  headers: Record<string, string>,
): { headers: Headers; body: Uint8Array } {
  return { headers: new Headers(headers), body: new TextEncoder().encode(body) };
}

/** 一則會寫入 Task 的 issues.edited webhook。 */
async function editedPayload(w: World) {
  const task = w.addTask();
  const outcome = await w.integration.onTaskChanged(task.id);
  if (outcome.kind !== "synced") throw new Error("同步失敗");
  const issue = w.github.humanEdit(w.repo.id, outcome.issueNumber, { title: "新標題" });
  return { task, payload: w.issuePayload("edited", issue, w.userRef(w.bob)) };
}

describe("簽章驗證", () => {
  it("verifyWebhookSignature：正確、錯誤、缺少、body 被改", () => {
    const body = '{"a":1}';
    const header = signWebhookBody(WEBHOOK_SECRET, body);
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(WEBHOOK_SECRET, body, header)).toBe(true);
    expect(verifyWebhookSignature("other-secret", body, header)).toBe(false);
    expect(verifyWebhookSignature(WEBHOOK_SECRET, '{"a":2}', header)).toBe(false);
    expect(verifyWebhookSignature(WEBHOOK_SECRET, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(WEBHOOK_SECRET, body, "sha1=abc")).toBe(false);
    expect(verifyWebhookSignature(WEBHOOK_SECRET, body, "sha256=00")).toBe(false);
  });

  it("簽章不對的 webhook 回 401，不處理也不記錄 delivery", async () => {
    const w = createWorld();
    const { task, payload } = await editedPayload(w);
    const body = JSON.stringify(payload);
    const response = await w.integration.handleWebhook(
      rawRequest(body, {
        "x-github-event": "issues",
        "x-github-delivery": "d-bad",
        "x-hub-signature-256": signWebhookBody("wrong-secret", body),
      }),
    );
    expect(response.status).toBe(401);
    expect(w.domain.fieldUpdates).toEqual([]);
    expect(w.store.deliveries.has("d-bad")).toBe(false);
    expect(w.domain.task(task.id).title).not.toBe("新標題");
  });

  it("缺少 event 或 delivery header 回 400；JSON 或格式不對回 400", async () => {
    const w = createWorld();
    const sign = (body: string) => signWebhookBody(WEBHOOK_SECRET, body);
    const body = JSON.stringify(fixture("issues.edited"));
    expect(
      (await w.integration.handleWebhook(rawRequest(body, { "x-hub-signature-256": sign(body) })))
        .status,
    ).toBe(400);
    const notJson = "{";
    expect(
      (
        await w.integration.handleWebhook(
          rawRequest(notJson, {
            "x-github-event": "issues",
            "x-github-delivery": "d-1",
            "x-hub-signature-256": sign(notJson),
          }),
        )
      ).status,
    ).toBe(400);
    const wrongShape = JSON.stringify({ action: "edited" });
    expect(
      (
        await w.integration.handleWebhook(
          rawRequest(wrongShape, {
            "x-github-event": "issues",
            "x-github-delivery": "d-2",
            "x-hub-signature-256": sign(wrongShape),
          }),
        )
      ).status,
    ).toBe(400);
  });

  it("ping 與沒有處理的事件回 202", async () => {
    const w = createWorld();
    expect(await w.deliver("ping", fixture("ping"))).toMatchObject({ status: 202 });
    expect(await w.deliver("star", { action: "created" })).toMatchObject({
      status: 202,
      body: { ignored: "star" },
    });
  });
});

describe("delivery ID 去重", () => {
  it("處理成功後同一個 delivery 再送一次回 duplicate，不再寫入", async () => {
    const w = createWorld();
    const { payload } = await editedPayload(w);
    expect((await w.deliver("issues", payload, { deliveryId: "d-1" })).status).toBe(200);
    expect(await w.deliver("issues", payload, { deliveryId: "d-1" })).toEqual({
      status: 200,
      body: { ok: true, duplicate: true },
    });
    expect(w.domain.fieldUpdates).toHaveLength(1);
  });

  it("處理失敗回 500 並放掉處理權；GitHub redelivery（同一個 delivery ID）會重新處理", async () => {
    const w = createWorld();
    const { task, payload } = await editedPayload(w);
    w.domain.failNext("updateTaskFields");

    const failed = await w.deliver("issues", payload, { deliveryId: "d-1" });
    expect(failed).toEqual({ status: 500, body: { ok: false, error: "handler_failed" } });
    expect(w.logger.entries.some((e) => e.level === "error")).toBe(true);

    const redelivered = await w.deliver("issues", payload, { deliveryId: "d-1" });
    expect(redelivered.status).toBe(200);
    expect(w.domain.task(task.id).title).toBe("新標題");
  });

  it("同一個 delivery 同時送達只處理一次，另一個回 409", async () => {
    const w = createWorld();
    const { payload } = await editedPayload(w);
    const results = await Promise.all([
      w.deliver("issues", payload, { deliveryId: "d-1" }),
      w.deliver("issues", payload, { deliveryId: "d-1" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(w.domain.fieldUpdates).toHaveLength(1);
  });

  it("處理中的 delivery 超過時限視為處理者掛掉，可以重新處理", async () => {
    const w = createWorld();
    const { payload } = await editedPayload(w);
    await w.store.claimDelivery({
      deliveryId: "d-1",
      event: "issues",
      now: w.clock.now(),
      staleAfterMs: DELIVERY_STALE_AFTER_MS,
    });
    expect((await w.deliver("issues", payload, { deliveryId: "d-1" })).status).toBe(409);
    w.clock.advance(DELIVERY_STALE_AFTER_MS + 1);
    expect((await w.deliver("issues", payload, { deliveryId: "d-1" })).status).toBe(200);
    expect(w.domain.fieldUpdates).toHaveLength(1);
  });
});

describe("Hono 路由", () => {
  it("以原始 bytes 驗證簽章並回傳處理結果", async () => {
    const w = createWorld();
    const { task, payload } = await editedPayload(w);
    const app = new Hono().route("/api/webhooks/github", createGitHubWebhookRoutes(w.integration));
    // 刻意用有空白與非 ASCII 的 JSON：簽章必須對原始 bytes 計算
    const body = JSON.stringify(payload, null, 2);
    const response = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "d-route",
        "x-hub-signature-256": signWebhookBody(WEBHOOK_SECRET, body),
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, event: "issues" });
    expect(w.domain.task(task.id).title).toBe("新標題");

    const bad = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": "d-x",
        "x-hub-signature-256": "sha256=0",
      },
      body,
    });
    expect(bad.status).toBe(401);
  });
});
