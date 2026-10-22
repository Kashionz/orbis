// API 測試共用：建立服務與 app、建立 Team 與四種 Role 的 Member（各自有 session）、送出請求。

import type { Role } from "@orbis/api-contract";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { expect } from "vitest";
import type { z } from "zod";
import { createApp } from "../../src/app";
import type { GitHubOAuth, GitHubUser } from "../../src/auth/github-oauth";
import { MemoryBlobStore } from "../../src/blobs/store";
import { ManualClock } from "../../src/clock";
import { randomToken, sha256Hex } from "../../src/crypto";
import type { Database } from "../../src/db/client";
import {
  acceptanceCriteria,
  members,
  projects,
  repos,
  sessions,
  tasks,
  teams,
} from "../../src/db/schema";
import type {
  OpenPullRequestInput,
  PullRequestOpener,
  RepoRegistrar,
} from "../../src/github/integration";
import { createLogger, type Logger } from "../../src/logger";
import { SESSION_COOKIE } from "../../src/routes/auth";
import { createServices, type Services, type ServicesOptions } from "../../src/services";

export const ROLES_UNDER_TEST: Role[] = ["owner", "admin", "member", "viewer"];

export const unusedGitHubOAuth: GitHubOAuth = {
  authorizeUrl: () => {
    throw new Error("unused");
  },
  exchangeCode: () => Promise.reject(new Error("unused")),
  fetchUser: () => Promise.reject(new Error("unused")),
};

/** 不連網路的 GitHub 使用者查詢。 */
export class FakeGitHubUsers {
  readonly users = new Map<string, GitHubUser>();

  add(user: GitHubUser): void {
    this.users.set(user.login.toLowerCase(), user);
  }

  readonly lookup = {
    findByLogin: async (login: string) => this.users.get(login.toLowerCase()) ?? null,
  };
}

/** 記錄被要求開的 PR。 */
export class FakePullRequestOpener implements PullRequestOpener {
  readonly opened: OpenPullRequestInput[] = [];

  async openPullRequest(input: OpenPullRequestInput): Promise<void> {
    this.opened.push(input);
  }
}

export interface TestContext {
  services: Services;
  app: Hono;
  clock: ManualClock;
  githubUsers: FakeGitHubUsers;
  pullRequests: FakePullRequestOpener;
  logger: Logger;
}

export function createTestContext(
  db: Database,
  options: Partial<ServicesOptions> & { repoRegistrar?: RepoRegistrar } = {},
): TestContext {
  const logger = createLogger({ level: "silent", pretty: false });
  const clock = new ManualClock(new Date("2026-10-23T08:00:00.000Z"));
  const githubUsers = new FakeGitHubUsers();
  const pullRequests = new FakePullRequestOpener();
  const services = createServices({
    db,
    logger,
    clock,
    blobStore: new MemoryBlobStore(),
    ...options,
    github: {
      userLookup: githubUsers.lookup,
      pullRequestOpener: pullRequests,
      ...(options.repoRegistrar && { repoRegistrar: options.repoRegistrar }),
      ...options.github,
    },
  });
  const app = createApp({
    config: { publicUrl: "http://localhost:5173", bootstrapOwnerGithubUserId: null },
    db,
    logger,
    githubOAuth: unusedGitHubOAuth,
    services,
  });
  return { services, app, clock, githubUsers, pullRequests, logger };
}

export interface SeededMember {
  id: string;
  role: Role;
  githubUserId: number;
  /** `Cookie` header 的值。 */
  cookie: string;
}

export interface SeededTeam {
  teamId: string;
  members: Record<Role, SeededMember>;
}

let nextGitHubUserId = 1000;

/** 建立一個 Member 與它的 session。 */
export async function seedMember(db: Database, teamId: string, role: Role): Promise<SeededMember> {
  const githubUserId = nextGitHubUserId++;
  const [member] = await db
    .insert(members)
    .values({ teamId, githubUserId, githubLogin: `user${githubUserId}`, role })
    .returning();
  if (!member) throw new Error("建立 Member 失敗");
  const token = randomToken();
  await db.insert(sessions).values({
    tokenHash: sha256Hex(token),
    githubUserId,
    githubLogin: `user${githubUserId}`,
    currentTeamId: teamId,
    expiresAt: new Date("2100-01-01T00:00:00.000Z"),
  });
  return { id: member.id, role, githubUserId, cookie: `${SESSION_COOKIE}=${token}` };
}

/** 建立 Team，以及 Owner、Admin、Member、Viewer 各一位。 */
export async function seedTeam(db: Database, name = "Core"): Promise<SeededTeam> {
  const [team] = await db.insert(teams).values({ name }).returning();
  if (!team) throw new Error("建立 Team 失敗");
  const seeded = {} as Record<Role, SeededMember>;
  for (const role of ROLES_UNDER_TEST) seeded[role] = await seedMember(db, team.id, role);
  return { teamId: team.id, members: seeded };
}

/** 直接在 DB 建立 Project 與 Repo（不經過 API）。 */
export async function seedProject(
  db: Database,
  teamId: string,
  overrides: Partial<typeof projects.$inferInsert> = {},
) {
  const [project] = await db
    .insert(projects)
    .values({ teamId, name: "Orbis", taskKeyPrefix: "ORB", ...overrides })
    .returning();
  if (!project) throw new Error("建立 Project 失敗");
  const [repo] = await db
    .insert(repos)
    .values({
      projectId: project.id,
      githubOwner: "acme",
      githubName: "orbis",
      defaultBranch: "main",
    })
    .returning();
  if (!repo) throw new Error("建立 Repo 失敗");
  return { project, repo };
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

/** 以某位 Member 的身分送出請求。 */
export function client(app: Hono, cookie: string | null) {
  async function send<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  }
  return {
    get: <T = unknown>(path: string) => send<T>("GET", path),
    post: <T = unknown>(path: string, body?: unknown) => send<T>("POST", path, body ?? {}),
    patch: <T = unknown>(path: string, body: unknown) => send<T>("PATCH", path, body),
    put: <T = unknown>(path: string, body: unknown) => send<T>("PUT", path, body),
    delete: <T = unknown>(path: string) => send<T>("DELETE", path),
  };
}

/** 回應必須符合契約的 schema；回傳解析後的值。 */
export function expectContract<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    expect.fail(`回應不符合契約：${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  return parsed.data;
}

/** 直接在 DB 建立一個已在 Ready、有一條 Acceptance Criterion 的 Task。 */
export async function seedReadyTask(
  db: Database,
  project: typeof projects.$inferSelect,
  repoId: string,
  overrides: Partial<typeof tasks.$inferInsert> = {},
) {
  const [counter] = await db
    .update(projects)
    .set({ nextTaskNumber: sql`${projects.nextTaskNumber} + 1` })
    .where(eq(projects.id, project.id))
    .returning({ next: projects.nextTaskNumber });
  const number = (counter?.next ?? 2) - 1;
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: project.id,
      number,
      key: `${project.taskKeyPrefix}-${number}`,
      repoId,
      title: "Add login page",
      description: "用 GitHub 登入",
      status: "ready",
      ...overrides,
    })
    .returning();
  if (!task) throw new Error("建立 Task 失敗");
  await db.insert(acceptanceCriteria).values({
    taskId: task.id,
    position: 0,
    kind: "command",
    description: "測試通過",
    command: "pnpm test",
  });
  return task;
}

/**
 * 清空測試資料。上一個測試關閉 Server 時，可能還有 Runner frame 的 transaction 在收尾，
 * truncate 會與它們死鎖（40P01），所以遇到死鎖就稍後重試。
 */
export async function resetDatabase(db: Database): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await db.execute(sql`truncate table teams, sessions cascade`);
      return;
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code !== "40P01" || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
