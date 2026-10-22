// GitHub OAuth 的呼叫介面。測試用 fake 實作替換，不連到真的 GitHub。

import { NAMES } from "@orbis/api-contract";
import { z } from "zod";

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GitHubOAuth {
  /** 組出導向 GitHub 授權頁的網址。 */
  authorizeUrl(params: { redirectUri: string; state: string }): string;
  /** 用 callback 收到的 code 換 access token。 */
  exchangeCode(params: { code: string; redirectUri: string }): Promise<string>;
  /** 用 access token 取得登入者。 */
  fetchUser(accessToken: string): Promise<GitHubUser>;
}

export class GitHubOAuthError extends Error {
  override name = "GitHubOAuthError";
}

const TokenResponse = z.union([
  z.object({ access_token: z.string().min(1) }),
  z.object({ error: z.string(), error_description: z.string().optional() }),
]);

const UserResponse = z.object({
  id: z.number().int(),
  login: z.string(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
});

/** 呼叫 github.com 的實作。只需要讀取公開的使用者資料，所以 scope 為空。 */
export function createGitHubOAuth(options: {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}): GitHubOAuth {
  const doFetch = options.fetch ?? fetch;
  return {
    authorizeUrl({ redirectUri, state }) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("allow_signup", "false");
      return url.toString();
    },

    async exchangeCode({ code, redirectUri }) {
      const response = await doFetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      if (!response.ok) {
        throw new GitHubOAuthError(`GitHub 換 token 失敗：HTTP ${response.status}`);
      }
      const body = TokenResponse.parse(await response.json());
      if ("error" in body) {
        throw new GitHubOAuthError(`GitHub 換 token 失敗：${body.error_description ?? body.error}`);
      }
      return body.access_token;
    },

    async fetchUser(accessToken) {
      const response = await doFetch("https://api.github.com/user", {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": NAMES.productSlug,
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!response.ok) {
        throw new GitHubOAuthError(`GitHub 取得使用者失敗：HTTP ${response.status}`);
      }
      const user = UserResponse.parse(await response.json());
      return {
        id: user.id,
        login: user.login,
        name: user.name ?? null,
        avatarUrl: user.avatar_url ?? null,
      };
    },
  };
}
