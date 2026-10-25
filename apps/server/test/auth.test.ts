import { MeResponse } from "@orbis/api-contract";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { GitHubOAuth, GitHubUser } from "../src/auth/github-oauth";
import { createGitHubOAuth } from "../src/auth/github-oauth";
import { members, sessions, teams } from "../src/db/schema";
import { createLogger } from "../src/logger";
import { OAUTH_RETURN_COOKIE, OAUTH_STATE_COOKIE, SESSION_COOKIE } from "../src/routes/auth";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";

const PUBLIC_URL = "http://localhost:5173";
/** `code-owner` 的 GitHub user id。 */
const BOOTSTRAP_OWNER_ID = 1;

const USERS: Record<string, GitHubUser> = {
  "code-owner": {
    id: 1,
    login: "octocat",
    name: "The Octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
  },
  "code-stranger": { id: 2, login: "stranger", name: null, avatarUrl: null },
  // 與 bootstrap owner 同 login、不同 user id：例如 owner 改名後，舊名稱被別人註冊。
  "code-impostor": { id: 99, login: "octocat", name: null, avatarUrl: null },
  "code-member": {
    id: 3,
    login: "teammate",
    name: "Team Mate",
    avatarUrl: "https://avatars.githubusercontent.com/u/3",
    email: "teammate@example.com",
  },
};

/** 不連網路的 GitHub OAuth：code 對應到固定的使用者。 */
class FakeGitHubOAuth implements GitHubOAuth {
  readonly exchanges: { code: string; redirectUri: string }[] = [];

  authorizeUrl({ redirectUri, state }: { redirectUri: string; state: string }): string {
    const url = new URL("https://github.test/login/oauth/authorize");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(params: { code: string; redirectUri: string }): Promise<string> {
    this.exchanges.push(params);
    if (!USERS[params.code]) throw new Error("bad_verification_code");
    return `token-${params.code}`;
  }

  async fetchUser(accessToken: string): Promise<GitHubUser> {
    const user = USERS[accessToken.replace(/^token-/, "")];
    if (!user) throw new Error("unknown token");
    return user;
  }
}

/** 從回應的 Set-Cookie 取出 cookie 值（被刪除的 cookie 回傳空字串）。 */
function cookieFrom(response: Response, name: string): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const [key, ...value] = (pair ?? "").split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

describe.skipIf(dbSkipReason !== null)("GitHub OAuth 登入", () => {
  let database: TestDatabase;
  let github: FakeGitHubOAuth;
  let app: Hono;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await database.db.execute(sql`truncate table teams, sessions cascade`);
    github = new FakeGitHubOAuth();
    app = createApp({
      config: { publicUrl: PUBLIC_URL, bootstrapOwnerGithubUserId: BOOTSTRAP_OWNER_ID },
      db: database.db,
      logger: createLogger({ level: "silent", pretty: false }),
      githubOAuth: github,
    });
  });

  /** 走完 login → callback，回傳 callback 的回應。 */
  async function login(code: string): Promise<Response> {
    const start = await app.request("/api/auth/github/login");
    const state = cookieFrom(start, OAUTH_STATE_COOKIE);
    if (!state) throw new Error("login 沒有設定 state cookie");
    return app.request(`/api/auth/github/callback?code=${code}&state=${state}`, {
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` },
    });
  }

  async function me(sessionToken?: string): Promise<Response> {
    return app.request("/api/auth/me", {
      headers: sessionToken ? { cookie: `${SESSION_COOKIE}=${sessionToken}` } : {},
    });
  }

  it("login 產生 state、存進 httpOnly cookie，並導向 GitHub", async () => {
    const response = await app.request("/api/auth/github/login");
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    const state = cookieFrom(response, OAUTH_STATE_COOKIE);
    expect(state).toBeTruthy();
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${PUBLIC_URL}/api/auth/github/callback`,
    );
    const setCookie = response.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it("bootstrap owner 第一次登入時建立 Team 與 Owner，/me 回傳符合 MeResponse 的資料", async () => {
    const callback = await login("code-owner");
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`${PUBLIC_URL}/`);
    expect(github.exchanges).toEqual([
      { code: "code-owner", redirectUri: `${PUBLIC_URL}/api/auth/github/callback` },
    ]);
    const sessionToken = cookieFrom(callback, SESSION_COOKIE);
    expect(sessionToken).toBeTruthy();
    expect(callback.headers.getSetCookie().join("\n")).toMatch(/HttpOnly/i);

    const response = await me(sessionToken);
    expect(response.status).toBe(200);
    const body = MeResponse.parse(await response.json());
    expect(body).toMatchObject({
      githubUserId: 1,
      githubLogin: "octocat",
      name: "The Octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
      member: { teamName: "octocat", role: "owner" },
    });

    const allTeams = await database.db.select().from(teams);
    expect(allTeams).toHaveLength(1);
    expect(body.member?.teamId).toBe(allTeams[0]?.id);

    // DB 只存 session token 的雜湊
    const [stored] = await database.db.select().from(sessions);
    expect(stored?.tokenHash).not.toBe(sessionToken);
  });

  it("bootstrap owner 再次登入不會重複建立 Team", async () => {
    await login("code-owner");
    const second = await login("code-owner");
    const body = MeResponse.parse(await (await me(cookieFrom(second, SESSION_COOKIE))).json());
    expect(body.member?.role).toBe("owner");
    expect(await database.db.select().from(teams)).toHaveLength(1);
    expect(await database.db.select().from(members)).toHaveLength(1);
  });

  it("不是 bootstrap owner 也沒有 Member 紀錄的人登入後 member 為 null", async () => {
    const callback = await login("code-stranger");
    expect(callback.status).toBe(302);
    const body = MeResponse.parse(await (await me(cookieFrom(callback, SESSION_COOKIE))).json());
    expect(body).toEqual({
      githubUserId: 2,
      githubLogin: "stranger",
      name: null,
      avatarUrl: null,
      member: null,
    });
    expect(await database.db.select().from(teams)).toHaveLength(0);
  });

  it("已有 Member 紀錄的人登入後進入該 Team，並更新 GitHub 資料快照", async () => {
    const [team] = await database.db.insert(teams).values({ name: "Core" }).returning();
    if (!team) throw new Error("unreachable");
    await database.db.insert(members).values({
      teamId: team.id,
      githubUserId: 3,
      githubLogin: "old-login",
      role: "admin",
    });

    const callback = await login("code-member");
    const body = MeResponse.parse(await (await me(cookieFrom(callback, SESSION_COOKIE))).json());
    expect(body.member).toMatchObject({ teamId: team.id, teamName: "Core", role: "admin" });
    const [member] = await database.db.select().from(members).where(eq(members.githubUserId, 3));
    expect(member?.githubLogin).toBe("teammate");
    expect(member?.name).toBe("Team Mate");
  });

  it("login 與 bootstrap owner 相同但 user id 不同的人不會成為 Owner", async () => {
    const callback = await login("code-impostor");
    const body = MeResponse.parse(await (await me(cookieFrom(callback, SESSION_COOKIE))).json());
    expect(body.githubLogin).toBe("octocat");
    expect(body.member).toBeNull();
    expect(await database.db.select().from(teams)).toHaveLength(0);
  });

  it("已有 Team 時，bootstrap owner 不會再建立新的 Team", async () => {
    await database.db.insert(teams).values({ name: "Existing" });
    const callback = await login("code-owner");
    const body = MeResponse.parse(await (await me(cookieFrom(callback, SESSION_COOKIE))).json());
    expect(body.member).toBeNull();
    expect(await database.db.select().from(teams)).toHaveLength(1);
  });

  it("state 不符時拒絕登入，不建立 session", async () => {
    const start = await app.request("/api/auth/github/login");
    const state = cookieFrom(start, OAUTH_STATE_COOKIE);
    const response = await app.request(
      "/api/auth/github/callback?code=code-owner&state=forged-state",
      { headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` } },
    );
    expect(response.status).toBe(400);
    expect(cookieFrom(response, SESSION_COOKIE)).toBeUndefined();
    expect(github.exchanges).toEqual([]);
    expect(await database.db.select().from(sessions)).toHaveLength(0);
  });

  it("沒有 state cookie 時拒絕登入", async () => {
    const response = await app.request("/api/auth/github/callback?code=code-owner&state=abc");
    expect(response.status).toBe(400);
    expect(github.exchanges).toEqual([]);
  });

  it("GitHub 換 token 失敗時回 502", async () => {
    const response = await login("code-unknown");
    expect(response.status).toBe(502);
    expect(cookieFrom(response, SESSION_COOKIE)).toBeUndefined();
  });

  it("未登入或 session 無效時 /me 回 401", async () => {
    expect((await me()).status).toBe(401);
    expect((await me("not-a-session")).status).toBe(401);
  });

  it("過期的 session 視為未登入", async () => {
    const callback = await login("code-stranger");
    await database.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await me(cookieFrom(callback, SESSION_COOKIE))).status).toBe(401);
  });

  it("logout 刪除 session，之後 /me 回 401", async () => {
    const callback = await login("code-owner");
    const sessionToken = cookieFrom(callback, SESSION_COOKIE);
    const response = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` },
    });
    expect(response.status).toBe(204);
    expect(cookieFrom(response, SESSION_COOKIE)).toBe("");
    expect((await me(sessionToken)).status).toBe(401);
    expect(await database.db.select().from(sessions)).toHaveLength(0);
  });

  it("登入時把已驗證的 email 寫進這個帳號所有的 Member 紀錄與 session；沒有時為 null", async () => {
    await login("code-owner");
    const [team] = await database.db.select().from(teams);
    const [other] = await database.db.insert(teams).values({ name: "Other" }).returning();
    for (const teamId of [team?.id, other?.id]) {
      await database.db
        .insert(members)
        .values({ teamId: teamId as string, githubUserId: 3, githubLogin: "old", role: "viewer" });
    }
    const callback = await login("code-member");
    const rows = await database.db.select().from(members).where(eq(members.githubUserId, 3));
    expect(rows.map((m) => m.email)).toEqual(["teammate@example.com", "teammate@example.com"]);
    const token = cookieFrom(callback, SESSION_COOKIE);
    const body = MeResponse.parse(await (await me(token)).json());
    expect(body.member?.email).toBe("teammate@example.com");
    const [session] = await database.db.select().from(sessions).where(eq(sessions.githubUserId, 3));
    expect(session?.verifiedEmail).toBe("teammate@example.com");

    // 沒有已驗證 email 的帳號：覆寫成 null
    USERS["code-member"] = { ...(USERS["code-member"] as GitHubUser), email: null };
    await login("code-member");
    const after = await database.db.select().from(members).where(eq(members.githubUserId, 3));
    expect(after.map((m) => m.email)).toEqual([null, null]);
    USERS["code-member"] = {
      ...(USERS["code-member"] as GitHubUser),
      email: "teammate@example.com",
    };
  });

  it("returnTo：登入完成後回到原本的路徑；不是同一個 origin 的路徑一律回首頁", async () => {
    const start = await app.request("/api/auth/github/login?returnTo=%2Finvites%2Fabc");
    const state = cookieFrom(start, OAUTH_STATE_COOKIE) as string;
    const back = cookieFrom(start, OAUTH_RETURN_COOKIE) as string;
    expect(decodeURIComponent(back)).toBe("/invites/abc");
    const callback = await app.request(`/api/auth/github/callback?code=code-owner&state=${state}`, {
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}; ${OAUTH_RETURN_COOKIE}=${back}` },
    });
    expect(callback.headers.get("location")).toBe(`${PUBLIC_URL}/invites/abc`);

    const evil = await app.request("/api/auth/github/login?returnTo=%2F%2Fevil.test");
    expect(cookieFrom(evil, OAUTH_RETURN_COOKIE) ?? "").toBe("");
  });

  it("GitHub OAuth 請求 user:email，取主要且已驗證的 email", async () => {
    const calls: string[] = [];
    const oauth = createGitHubOAuth({
      clientId: "id",
      clientSecret: "secret",
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/user")) {
          return Response.json({ id: 7, login: "x", name: null, avatar_url: null });
        }
        return Response.json([
          { email: "old@example.com", primary: false, verified: true },
          { email: "Me@Example.com", primary: true, verified: true },
        ]);
      },
    });
    expect(
      new URL(oauth.authorizeUrl({ redirectUri: "http://x", state: "s" })).searchParams.get(
        "scope",
      ),
    ).toBe("user:email");
    const user = await oauth.fetchUser("token");
    expect(user.email).toBe("me@example.com");
    expect(calls).toContain("https://api.github.com/user/emails");

    const unverified = createGitHubOAuth({
      clientId: "id",
      clientSecret: "secret",
      fetch: async (input) =>
        String(input).endsWith("/user")
          ? Response.json({ id: 7, login: "x" })
          : Response.json([{ email: "me@example.com", primary: true, verified: false }]),
    });
    expect((await unverified.fetchUser("token")).email).toBeNull();
    const failing = createGitHubOAuth({
      clientId: "id",
      clientSecret: "secret",
      fetch: async (input) =>
        String(input).endsWith("/user")
          ? Response.json({ id: 7, login: "x" })
          : new Response("forbidden", { status: 403 }),
    });
    expect((await failing.fetchUser("token")).email).toBeNull();
  });
});
