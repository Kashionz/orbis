// GitHubClient 的實作：直接用 fetch 呼叫 GitHub REST API，回應以 zod 驗證。

import { NAMES } from "@orbis/api-contract";
import { z } from "zod";
import { createAppJwtSigner } from "../auth/app-jwt";
import { type InstallationToken, InstallationTokenCache } from "../auth/installation-tokens";
import {
  GitHubApiError,
  type GitHubClient,
  type GitHubIssue,
  type GitHubPullRequest,
  type RepoRef,
} from "./types";

export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
/** 列出 Issue 時最多翻幾頁（每頁 100 筆）。 */
const MAX_PAGES = 20;

type Auth = { kind: "app" } | { kind: "installation"; installationId: number };

const UserRef = z.object({ id: z.number(), login: z.string(), type: z.string() });

export const IssueResponse = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.enum(["open", "closed"]),
  state_reason: z.enum(["completed", "not_planned", "reopened"]).nullable().optional(),
  assignees: z.array(UserRef).nullable().optional(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  updated_at: z.string(),
  html_url: z.string(),
  pull_request: z.unknown().optional(),
});

const RepoResponse = z.object({
  id: z.number(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
  default_branch: z.string(),
  html_url: z.string(),
});

const PullRequestResponse = z.object({
  id: z.number(),
  number: z.number(),
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
});

const TokenResponse = z.object({ token: z.string(), expires_at: z.string() });
const IdResponse = z.object({ id: z.number() });
const ErrorResponse = z.object({ message: z.string() }).partial();

export function toIssue(raw: z.infer<typeof IssueResponse>): GitHubIssue {
  return {
    id: raw.id,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    stateReason: raw.state_reason ?? null,
    assignees: (raw.assignees ?? []).map((u) => ({ id: u.id, login: u.login, type: u.type })),
    labels: raw.labels.map((l) => (typeof l === "string" ? l : l.name)),
    updatedAt: raw.updated_at,
    htmlUrl: raw.html_url,
    isPullRequest: raw.pull_request !== undefined,
  };
}

function toPullRequest(raw: z.infer<typeof PullRequestResponse>): GitHubPullRequest {
  return {
    id: raw.id,
    number: raw.number,
    htmlUrl: raw.html_url,
    state: raw.state,
    merged: raw.merged ?? Boolean(raw.merged_at),
    headRef: raw.head.ref,
    headSha: raw.head.sha,
    baseRef: raw.base.ref,
  };
}

function repoPath(repo: RepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** 從 `Link` header 取出下一頁的網址。 */
function nextPage(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

export interface HttpGitHubClientOptions {
  appId: number;
  privateKey: string;
  /** 測試用：替換 fetch。 */
  fetch?: typeof fetch;
  apiUrl?: string;
  now?: () => number;
}

export function createHttpGitHubClient(options: HttpGitHubClientOptions): GitHubClient {
  const doFetch = options.fetch ?? fetch;
  const apiUrl = (options.apiUrl ?? GITHUB_API_URL).replace(/\/+$/, "");
  const signer = createAppJwtSigner({
    appId: options.appId,
    privateKey: options.privateKey,
    ...(options.now ? { now: options.now } : {}),
  });

  async function authorization(auth: Auth): Promise<string> {
    if (auth.kind === "app") return `Bearer ${signer.token()}`;
    return `token ${await tokens.get(auth.installationId)}`;
  }

  async function send(
    method: string,
    pathOrUrl: string,
    auth: Auth,
    body?: unknown,
  ): Promise<Response> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${apiUrl}${pathOrUrl}`;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: await authorization(auth),
      "user-agent": NAMES.productSlug,
      "x-github-api-version": GITHUB_API_VERSION,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return doFetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  /**
   * 送出請求並解析回應。installation token 回 401 時（例如被撤銷）丟掉快取重試一次。
   * `allowNotFound` 時 404 回傳 null。
   */
  async function request<T>(
    method: string,
    pathOrUrl: string,
    auth: Auth,
    schema: z.ZodType<T>,
    opts: { body?: unknown; allowNotFound?: boolean } = {},
  ): Promise<{ data: T; response: Response } | null> {
    let response = await send(method, pathOrUrl, auth, opts.body);
    if (response.status === 401 && auth.kind === "installation") {
      tokens.invalidate(auth.installationId);
      response = await send(method, pathOrUrl, auth, opts.body);
    }
    if (response.status === 404 && opts.allowNotFound) return null;
    if (!response.ok) {
      const parsed = ErrorResponse.safeParse(await response.json().catch(() => ({})));
      const detail = parsed.success && parsed.data.message ? `：${parsed.data.message}` : "";
      throw new GitHubApiError(
        response.status,
        `GitHub API ${method} ${pathOrUrl} 失敗：HTTP ${response.status}${detail}`,
      );
    }
    const json = response.status === 204 ? {} : await response.json();
    return { data: schema.parse(json), response };
  }

  async function must<T>(result: Promise<{ data: T; response: Response } | null>): Promise<T> {
    const value = await result;
    if (!value) throw new GitHubApiError(404, "GitHub API 回傳 404");
    return value.data;
  }

  const inst = (installationId: number): Auth => ({ kind: "installation", installationId });

  async function createInstallationToken(installationId: number): Promise<InstallationToken> {
    const data = await must(
      request(
        "POST",
        `/app/installations/${installationId}/access_tokens`,
        { kind: "app" },
        TokenResponse,
      ),
    );
    return { token: data.token, expiresAt: new Date(data.expires_at) };
  }

  const tokens = new InstallationTokenCache({
    fetchToken: createInstallationToken,
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    async findRepoInstallation(repo) {
      const result = await request(
        "GET",
        `${repoPath(repo)}/installation`,
        { kind: "app" },
        IdResponse,
        { allowNotFound: true },
      );
      return result ? { installationId: result.data.id } : null;
    },

    createInstallationToken,

    installationToken(installationId) {
      return tokens.get(installationId);
    },

    forgetInstallation(installationId) {
      tokens.invalidate(installationId);
    },

    async getRepo(installationId, repo) {
      const result = await request("GET", repoPath(repo), inst(installationId), RepoResponse, {
        allowNotFound: true,
      });
      if (!result) return null;
      const r = result.data;
      return {
        id: r.id,
        owner: r.owner.login,
        name: r.name,
        defaultBranch: r.default_branch,
        htmlUrl: r.html_url,
      };
    },

    async getIssue(installationId, repo, number) {
      const result = await request(
        "GET",
        `${repoPath(repo)}/issues/${number}`,
        inst(installationId),
        IssueResponse,
        { allowNotFound: true },
      );
      return result ? toIssue(result.data) : null;
    },

    async listOpenIssues(installationId, repo) {
      const issues: GitHubIssue[] = [];
      let url: string | null = `${repoPath(repo)}/issues?state=open&per_page=100`;
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const result = await request("GET", url, inst(installationId), z.array(IssueResponse));
        if (!result) break;
        issues.push(...result.data.map(toIssue).filter((issue) => !issue.isPullRequest));
        url = nextPage(result.response.headers.get("link"));
      }
      return issues;
    },

    async createIssue(installationId, repo, input) {
      return toIssue(
        await must(
          request("POST", `${repoPath(repo)}/issues`, inst(installationId), IssueResponse, {
            body: input,
          }),
        ),
      );
    },

    async updateIssue(installationId, repo, number, patch) {
      const body: Record<string, unknown> = { ...patch };
      if (patch.stateReason !== undefined) {
        body.state_reason = patch.stateReason;
        delete body.stateReason;
      }
      return toIssue(
        await must(
          request(
            "PATCH",
            `${repoPath(repo)}/issues/${number}`,
            inst(installationId),
            IssueResponse,
            { body },
          ),
        ),
      );
    },

    async createIssueComment(installationId, repo, issueNumber, body) {
      const data = await must(
        request(
          "POST",
          `${repoPath(repo)}/issues/${issueNumber}/comments`,
          inst(installationId),
          IdResponse,
          { body: { body } },
        ),
      );
      return { id: data.id };
    },

    async updateIssueComment(installationId, repo, commentId, body) {
      const result = await request(
        "PATCH",
        `${repoPath(repo)}/issues/comments/${commentId}`,
        inst(installationId),
        IdResponse,
        { body: { body }, allowNotFound: true },
      );
      return result ? { id: result.data.id } : null;
    },

    async findOpenPullRequest(installationId, repo, head) {
      const query = new URLSearchParams({ state: "open", head: `${repo.owner}:${head}` });
      const data = await must(
        request(
          "GET",
          `${repoPath(repo)}/pulls?${query}`,
          inst(installationId),
          z.array(PullRequestResponse),
        ),
      );
      const first = data[0];
      return first ? toPullRequest(first) : null;
    },

    async createPullRequest(installationId, repo, input) {
      return toPullRequest(
        await must(
          request("POST", `${repoPath(repo)}/pulls`, inst(installationId), PullRequestResponse, {
            body: input,
          }),
        ),
      );
    },
  };
}
