// GitHub App 整合的測試環境：D 軌的 FakeGitHub（in-memory 的 GitHub）＋真實的 Server 服務。
// webhook payload 以 packages/github 錄製的真實 payload 為底（packages/github/test/fixtures/webhooks）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type GitHubUserRef, signWebhookBody } from "@orbis/github";
import { FakeGitHub, RecordingNotifier, TestClock } from "@orbis/github/testing";
import type { GitHubAppOptions } from "../../src/github/app";
import type { SeededMember } from "./api";

export const WEBHOOK_SECRET = "test-webhook-secret";
export const APP_SLUG = "orbis-test";

const FIXTURE_DIR = fileURLToPath(
  new URL("../../../../packages/github/test/fixtures/webhooks/", import.meta.url),
);

/** 讀取錄製的 webhook payload。每次回傳新的物件。 */
// biome-ignore lint/suspicious/noExplicitAny: fixture 是任意 JSON，測試中直接改寫欄位
export function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, "utf8"));
}

export interface FakeGitHubApp {
  clock: TestClock;
  github: FakeGitHub;
  notifier: RecordingNotifier;
  bot: GitHubUserRef;
  /** 傳給 createTestContext 的 `github.app`。 */
  options: GitHubAppOptions;
  /** 讓 Member 在 GitHub 上有帳號，並設定對 repo 的角色。 */
  addMember(member: SeededMember, role: "admin" | "write" | "read" | "none"): GitHubUserRef;
  /** 簽名後的 webhook request（送給 app.request）。 */
  webhook(event: string, payload: unknown, deliveryId?: string): RequestInit;
}

let deliveryCounter = 0;

export function createFakeGitHubApp(): FakeGitHubApp {
  const clock = new TestClock();
  const bot: GitHubUserRef = { id: 9_000_001, login: `${APP_SLUG}[bot]`, type: "Bot" };
  const github = new FakeGitHub(clock, bot);
  const notifier = new RecordingNotifier();
  return {
    clock,
    github,
    notifier,
    bot,
    options: {
      config: { appId: 1, privateKey: "unused", webhookSecret: WEBHOOK_SECRET, slug: APP_SLUG },
      client: github,
      notifier,
    },
    addMember(member, role) {
      const user: GitHubUserRef = {
        id: member.githubUserId,
        login: `user${member.githubUserId}`,
        type: "User",
      };
      github.addUser(user);
      github.roles.set(user.login, role);
      return user;
    },
    webhook(event, payload, deliveryId) {
      const body = JSON.stringify(payload);
      return {
        method: "POST",
        headers: {
          "x-github-event": event,
          "x-github-delivery": deliveryId ?? `delivery-${++deliveryCounter}`,
          "x-hub-signature-256": signWebhookBody(WEBHOOK_SECRET, body),
          "content-type": "application/json",
        },
        body,
      };
    },
  };
}
