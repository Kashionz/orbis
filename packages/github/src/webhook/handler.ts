// webhook 入口：驗證簽章 → 解析 → 以 delivery ID 去重 → 交給對應的處理函式。
// 同步處理完才回應（處理都很快，GitHub 的逾時是 10 秒）。處理失敗回 500，
// 並放掉處理權，讓 GitHub 的 redelivery（同一個 delivery ID）可以重新處理。

import type { z } from "zod";
import type { IntegrationContext } from "../context";
import { handleIssuesEvent, handleSummaryCommentDeleted } from "../issues/sync";
import { handlePullRequestEvent } from "../pull-requests";
import { handleInstallationEvent, handleInstallationRepositoriesEvent } from "../repos";
import {
  InstallationPayload,
  InstallationRepositoriesPayload,
  IssueCommentPayload,
  IssuesPayload,
  PullRequestPayload,
} from "./payloads";
import { verifyWebhookSignature } from "./verify";

/** 處理中的 delivery 超過這個時間沒有完成，視為處理者已經掛掉。 */
export const DELIVERY_STALE_AFTER_MS = 5 * 60 * 1000;

interface EventHandler<T> {
  schema: z.ZodType<T>;
  handle(ctx: IntegrationContext, payload: T): Promise<unknown>;
}

function handler<T>(
  schema: z.ZodType<T>,
  handle: (ctx: IntegrationContext, payload: T) => Promise<unknown>,
): EventHandler<unknown> {
  return { schema, handle } as EventHandler<unknown>;
}

/**
 * D1 處理的 webhook 事件。App manifest 訂閱的事件見 app-manifest.json；
 * `pull_request_review`、`check_suite` 等由 D2（Feedback Loop）處理。
 */
export const WEBHOOK_HANDLERS: Record<string, EventHandler<unknown>> = {
  issues: handler(IssuesPayload, handleIssuesEvent),
  issue_comment: handler(IssueCommentPayload, async (ctx, payload) => {
    if (payload.action !== "deleted") return { kind: "ignored" };
    return {
      recreated: await handleSummaryCommentDeleted(
        ctx,
        payload.repository.id,
        payload.issue.number,
        payload.comment.id,
      ),
    };
  }),
  pull_request: handler(PullRequestPayload, handlePullRequestEvent),
  installation: handler(InstallationPayload, handleInstallationEvent),
  installation_repositories: handler(
    InstallationRepositoriesPayload,
    handleInstallationRepositoriesEvent,
  ),
};

export interface WebhookRequest {
  headers: { get(name: string): string | null | undefined };
  body: Uint8Array;
}

export type WebhookResult =
  | { status: 200; body: { ok: true; event: string; result: unknown } }
  | { status: 200; body: { ok: true; duplicate: true } }
  | { status: 202; body: { ok: true; ignored: string } }
  | { status: 400 | 401 | 409 | 500; body: { ok: false; error: string } };

export async function handleWebhook(
  ctx: IntegrationContext,
  secret: string,
  request: WebhookRequest,
): Promise<WebhookResult> {
  if (!verifyWebhookSignature(secret, request.body, request.headers.get("x-hub-signature-256"))) {
    ctx.logger.warn({}, "GitHub webhook 簽章不正確，拒絕");
    return { status: 401, body: { ok: false, error: "invalid_signature" } };
  }

  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  if (!event || !deliveryId) {
    return { status: 400, body: { ok: false, error: "missing_headers" } };
  }
  if (event === "ping") return { status: 202, body: { ok: true, ignored: "ping" } };

  const entry = WEBHOOK_HANDLERS[event];
  if (!entry) return { status: 202, body: { ok: true, ignored: event } };

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(request.body).toString("utf8"));
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_json" } };
  }
  const parsed = entry.schema.safeParse(json);
  if (!parsed.success) {
    ctx.logger.warn({ event, deliveryId, issues: parsed.error.issues }, "GitHub webhook 格式不符");
    return { status: 400, body: { ok: false, error: "invalid_payload" } };
  }

  const claim = await ctx.store.claimDelivery({
    deliveryId,
    event,
    now: ctx.now(),
    staleAfterMs: DELIVERY_STALE_AFTER_MS,
  });
  if (claim === "duplicate") return { status: 200, body: { ok: true, duplicate: true } };
  if (claim === "in_progress") return { status: 409, body: { ok: false, error: "in_progress" } };

  try {
    const result = await entry.handle(ctx, parsed.data);
    await ctx.store.completeDelivery(deliveryId, ctx.now());
    return { status: 200, body: { ok: true, event, result } };
  } catch (error) {
    await ctx.store.releaseDelivery(deliveryId);
    ctx.logger.error({ err: error, event, deliveryId }, "處理 GitHub webhook 時發生錯誤");
    return { status: 500, body: { ok: false, error: "handler_failed" } };
  }
}
