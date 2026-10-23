// GitHub OAuth 登入路由（路徑取自 API_ROUTES 的 auth*）。

import { API_ROUTES, NAMES } from "@orbis/api-contract";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import type { GitHubOAuth } from "../auth/github-oauth";
import {
  buildMeResponse,
  deleteSession,
  findSession,
  SESSION_TTL_MS,
  signIn,
} from "../auth/service";
import { constantTimeEqual, randomToken } from "../crypto";
import type { Database } from "../db/client";
import type { Logger } from "../logger";

export const SESSION_COOKIE = `${NAMES.productSlug}_session`;
export const OAUTH_STATE_COOKIE = `${NAMES.productSlug}_oauth_state`;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export interface AuthRouteDeps {
  db: Database;
  logger: Logger;
  githubOAuth: GitHubOAuth;
  /** Web 的 origin；redirect_uri 經由 Vite proxy 回到 Server。 */
  publicUrl: string;
  bootstrapOwnerGithubUserId: number | null;
  /**
   * 登出時結束 session：先撤銷它配對的 Local Runner 再刪除（auth/session-cleanup.ts 的 endSession）。
   * 未提供時只刪除 session。
   */
  endSession?: (sessionToken: string) => Promise<void>;
}

export function createAuthRoutes(deps: AuthRouteDeps): Hono {
  const { db, logger, githubOAuth, publicUrl } = deps;
  const endSession = deps.endSession ?? ((token: string) => deleteSession(db, token));
  const redirectUri = `${publicUrl}${API_ROUTES.authGithubCallback}`;
  // state cookie 只送給登入與 callback 兩個路徑。
  const stateCookiePath = API_ROUTES.authGithubLogin.slice(
    0,
    API_ROUTES.authGithubLogin.lastIndexOf("/"),
  );
  const secure = publicUrl.startsWith("https:");
  const baseCookie: CookieOptions = { httpOnly: true, secure, sameSite: "Lax" };

  const app = new Hono();

  app.get(API_ROUTES.authGithubLogin, (c) => {
    const state = randomToken();
    setCookie(c, OAUTH_STATE_COOKIE, state, {
      ...baseCookie,
      path: stateCookiePath,
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });
    return c.redirect(githubOAuth.authorizeUrl({ redirectUri, state }));
  });

  app.get(API_ROUTES.authGithubCallback, async (c) => {
    const expectedState = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { ...baseCookie, path: stateCookiePath });
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!expectedState || !state || !constantTimeEqual(state, expectedState)) {
      logger.warn("GitHub OAuth callback 的 state 不符，拒絕登入");
      return c.json({ error: "invalid_state", message: "登入狀態已失效，請重新登入" }, 400);
    }
    if (!code) {
      return c.json({ error: "missing_code", message: "GitHub 沒有回傳授權碼" }, 400);
    }

    let user: Awaited<ReturnType<GitHubOAuth["fetchUser"]>>;
    try {
      // access token 只用來取得使用者，不保存（ADR-0007）。
      const accessToken = await githubOAuth.exchangeCode({ code, redirectUri });
      user = await githubOAuth.fetchUser(accessToken);
    } catch (error) {
      logger.error({ err: error }, "GitHub OAuth 失敗");
      return c.json({ error: "github_error", message: "無法向 GitHub 完成登入" }, 502);
    }

    const result = await signIn(db, user, {
      bootstrapOwnerGithubUserId: deps.bootstrapOwnerGithubUserId,
    });
    logger.info(
      {
        githubUserId: user.id,
        githubLogin: user.login,
        teamId: result.session.currentTeamId,
        bootstrapped: result.bootstrapped,
      },
      result.bootstrapped ? "bootstrap owner 登入，已建立 Team" : "GitHub 登入成功",
    );
    setCookie(c, SESSION_COOKIE, result.sessionToken, {
      ...baseCookie,
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return c.redirect(`${publicUrl}/`);
  });

  app.get(API_ROUTES.authMe, async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? await findSession(db, token) : null;
    if (!session) {
      return c.json({ error: "unauthorized", message: "尚未登入" }, 401);
    }
    return c.json(await buildMeResponse(db, session));
  });

  app.post(API_ROUTES.authLogout, async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await endSession(token);
    deleteCookie(c, SESSION_COOKIE, { ...baseCookie, path: "/" });
    return c.body(null, 204);
  });

  return app;
}
