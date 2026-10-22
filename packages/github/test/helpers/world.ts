// 測試共用的環境：FakeGitHub、FakeDomainService、in-memory store，以及以錄製的真實 payload
// （test/fixtures/webhooks）為底組出 webhook 的輔助函式。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GitHubIssue, GitHubUserRef } from "../../src/client/types";
import { createGitHubIntegration, type GitHubIntegration } from "../../src/integration";
import type { MemberRecord, TaskRecord } from "../../src/ports";
import {
  FakeDomainService,
  FakeGitHub,
  type FakeRepo,
  InMemoryGitHubStore,
  MemoryLogger,
  RecordingNotifier,
  TestClock,
} from "../../src/testing";
import { signWebhookBody } from "../../src/webhook/verify";

export const WEBHOOK_SECRET = "test-webhook-secret";
export const APP_SLUG = "acme-pm";
export const PROJECT_ID = "project-1";
export const REPO_ID = "repo-1";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/webhooks/", import.meta.url));

/** 讀取錄製的 webhook payload。每次回傳新的物件。 */
// biome-ignore lint/suspicious/noExplicitAny: fixture 是任意 JSON，測試中直接改寫欄位
export function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, "utf8"));
}

/** webhook payload 中的使用者物件（以 fixture 的欄位為底）。 */
function userObject(base: Record<string, unknown>, user: GitHubUserRef): Record<string, unknown> {
  return {
    ...base,
    id: user.id,
    login: user.login,
    type: user.type,
    html_url: `https://github.com/${user.login}`,
  };
}

export interface World {
  clock: TestClock;
  github: FakeGitHub;
  domain: FakeDomainService;
  store: InMemoryGitHubStore;
  notifier: RecordingNotifier;
  logger: MemoryLogger;
  integration: GitHubIntegration;
  repo: FakeRepo;
  bot: GitHubUserRef;
  alice: MemberRecord;
  bob: MemberRecord;
  /** 不是 Team 成員的 GitHub 帳號。 */
  outsider: GitHubUserRef;
  addTask(overrides?: Partial<TaskRecord>): TaskRecord;
  /** 簽名後送出 webhook。 */
  deliver(
    event: string,
    payload: unknown,
    options?: { deliveryId?: string },
  ): ReturnType<GitHubIntegration["handleWebhook"]>;
  issuePayload(action: string, issue: GitHubIssue, sender: GitHubUserRef): unknown;
  pullRequestPayload(
    action: "closed" | "reopened" | "opened",
    number: number,
    options: { merged: boolean; sender: GitHubUserRef },
  ): unknown;
  userRef(member: MemberRecord): GitHubUserRef;
}

let deliveryCounter = 0;

export function createWorld(): World {
  const clock = new TestClock();
  const bot: GitHubUserRef = { id: 9_000_001, login: `${APP_SLUG}[bot]`, type: "Bot" };
  const github = new FakeGitHub(clock, bot);
  // 與 fixture 中的 repository 相同，讓錄製的 payload 原樣也對得上。
  const base = fixture("issues.edited").repository as {
    id: number;
    name: string;
    owner: { login: string };
  };
  const repo = github.addRepo({
    id: base.id,
    owner: base.owner.login,
    name: base.name,
    defaultBranch: "main",
    installationId: 2_311_213,
  });
  const domain = new FakeDomainService(clock);
  domain.addRepo({
    id: REPO_ID,
    projectId: PROJECT_ID,
    owner: repo.owner,
    name: repo.name,
    githubRepoId: repo.id,
    defaultBranch: "main",
    installationId: repo.installationId,
  });
  const alice = domain.addMember(
    { id: "member-alice", githubUserId: 21_031_067, githubLogin: "Codertocat" },
    [PROJECT_ID],
  );
  const bob = domain.addMember({ id: "member-bob", githubUserId: 2002, githubLogin: "bob" }, [
    PROJECT_ID,
  ]);
  const outsider: GitHubUserRef = { id: 3003, login: "outsider", type: "User" };
  for (const m of [alice, bob])
    github.addUser({ id: m.githubUserId, login: m.githubLogin, type: "User" });
  github.addUser(outsider);

  const store = new InMemoryGitHubStore();
  const notifier = new RecordingNotifier();
  const logger = new MemoryLogger();
  const integration = createGitHubIntegration({
    config: { appId: 1, privateKey: "unused", webhookSecret: WEBHOOK_SECRET, slug: APP_SLUG },
    client: github,
    domain,
    store,
    notifier,
    logger,
    taskUrl: (task) => `https://pm.test/tasks/${task.key}`,
    now: () => clock.now(),
  });

  const userRef = (member: MemberRecord): GitHubUserRef => ({
    id: member.githubUserId,
    login: member.githubLogin,
    type: "User",
  });

  return {
    clock,
    github,
    domain,
    store,
    notifier,
    logger,
    integration,
    repo,
    bot,
    alice,
    bob,
    outsider,
    userRef,

    addTask(overrides = {}) {
      return domain.addTask({
        projectId: PROJECT_ID,
        repoId: REPO_ID,
        title: "修正 README 的錯字",
        description: "README 第 3 行拼錯了。",
        createdByMemberId: alice.id,
        ...overrides,
      });
    },

    deliver(event, payload, options = {}) {
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const headers = new Headers({
        "x-github-event": event,
        "x-github-delivery": options.deliveryId ?? `delivery-${++deliveryCounter}`,
        "x-hub-signature-256": signWebhookBody(WEBHOOK_SECRET, body),
        "content-type": "application/json",
      });
      return integration.handleWebhook({ headers, body });
    },

    issuePayload(action, issue, sender) {
      const payload = fixture(`issues.${action}`);
      const userBase = payload.sender as Record<string, unknown>;
      const labelBase = (payload.issue.labels?.[0] ?? { id: 1, color: "ededed" }) as Record<
        string,
        unknown
      >;
      const assignees = issue.assignees.map((a) => userObject(userBase, a));
      payload.issue = {
        ...payload.issue,
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body === "" ? null : issue.body,
        state: issue.state,
        state_reason: issue.stateReason,
        assignee: assignees[0] ?? null,
        assignees,
        labels: issue.labels.map((name) => ({ ...labelBase, name })),
        updated_at: issue.updatedAt,
        html_url: issue.htmlUrl,
      };
      payload.repository = {
        ...payload.repository,
        id: repo.id,
        name: repo.name,
        owner: { ...payload.repository.owner, login: repo.owner },
      };
      payload.sender = userObject(userBase, sender);
      return payload;
    },

    pullRequestPayload(action, number, options) {
      const payload = fixture(`pull_request.${action}`);
      const pull = github.pulls.get(repo.id)?.find((p) => p.number === number);
      payload.number = number;
      payload.pull_request = {
        ...payload.pull_request,
        number,
        html_url: `${repo.htmlUrl}/pull/${number}`,
        state: action === "reopened" || action === "opened" ? "open" : "closed",
        merged: options.merged,
        head: { ...payload.pull_request.head, ref: pull?.headRef ?? "feature", sha: pull?.headSha },
      };
      payload.repository = { ...payload.repository, id: repo.id, name: repo.name };
      payload.sender = userObject(payload.sender as Record<string, unknown>, options.sender);
      return payload;
    },
  };
}
