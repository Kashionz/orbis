// GitHubClient 的實作：直接用 fetch 呼叫 GitHub REST API，回應以 zod 驗證。

import { NAMES } from "@orbis/api-contract";
import { z } from "zod";
import { createAppJwtSigner } from "../auth/app-jwt";
import { type InstallationToken, InstallationTokenCache } from "../auth/installation-tokens";
import {
  GitHubApiError,
  type GitHubCheckAnnotation,
  type GitHubCheckRun,
  type GitHubCheckSuite,
  type GitHubClient,
  type GitHubFileContent,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubReviewComment,
  type RepoRef,
  type RepoRole,
  type TokenScope,
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
  // GitHub 之後可能再加入新的關閉原因；不認得的值當成沒有原因，不讓整個 payload 解析失敗。
  state_reason: z
    .enum(["completed", "not_planned", "duplicate", "reopened"])
    .nullable()
    .optional()
    .catch(null),
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

const InstallationRepositoriesResponse = z.object({
  repositories: z.array(z.object({ id: z.number(), full_name: z.string() })),
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

const ReviewCommentResponse = z.object({
  id: z.number(),
  pull_request_review_id: z.number().nullable().optional(),
  user: UserRef,
  body: z.string(),
  path: z.string(),
  line: z.number().nullable().optional(),
  start_line: z.number().nullable().optional(),
  side: z.enum(["LEFT", "RIGHT"]).nullable().optional().catch(null),
  diff_hunk: z.string(),
  html_url: z.string(),
});

const AppRef = z.object({ slug: z.string() }).nullable().optional();

const CheckSuitesResponse = z.object({
  check_suites: z.array(
    z.object({
      id: z.number(),
      app: AppRef,
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
      latest_check_runs_count: z.number().optional(),
    }),
  ),
});

const CheckRunsResponse = z.object({
  check_runs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      app: AppRef,
      html_url: z.string().nullable(),
      output: z
        .object({ title: z.string().nullable(), summary: z.string().nullable() })
        .partial()
        .optional(),
    }),
  ),
});

const AnnotationsResponse = z.array(
  z.object({
    path: z.string(),
    start_line: z.number().nullable().optional(),
    end_line: z.number().nullable().optional(),
    annotation_level: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    message: z.string(),
  }),
);

const RefResponse = z.object({ object: z.object({ sha: z.string() }) });
const ContentResponse = z.object({
  type: z.string(),
  sha: z.string(),
  content: z.string().optional(),
  encoding: z.string().optional(),
});
const PutFileResponse = z.object({
  content: z.object({ sha: z.string() }),
  commit: z.object({ sha: z.string() }),
});

const PermissionResponse = z.object({
  permission: z.string(),
  role_name: z.string().optional(),
  user: z.object({ id: z.number() }).nullable().optional(),
});
const ROLES: ReadonlySet<string> = new Set([
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
  "none",
]);
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

function toReviewComment(raw: z.infer<typeof ReviewCommentResponse>): GitHubReviewComment {
  return {
    id: raw.id,
    reviewId: raw.pull_request_review_id ?? null,
    user: { id: raw.user.id, login: raw.user.login, type: raw.user.type },
    body: raw.body,
    path: raw.path,
    line: raw.line ?? null,
    startLine: raw.start_line ?? null,
    side: raw.side ?? null,
    diffHunk: raw.diff_hunk,
    htmlUrl: raw.html_url,
  };
}

/** job log 最多讀幾個 byte。log 可能很大，只保留最後的部分（錯誤通常在最後）。 */
export const MAX_JOB_LOG_BYTES = 8 * 1024 * 1024;

/** 以串流讀取 body，只保留最後 `maxBytes`；有截掉時丟掉第一個不完整的行。 */
export async function readTail(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  let dropped = false;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    size += chunk.byteLength;
    // 去掉前面的 chunk，但至少保留 maxBytes
    while (chunks.length > 1 && size - (chunks[0]?.byteLength ?? 0) >= maxBytes) {
      size -= chunks.shift()?.byteLength ?? 0;
      dropped = true;
    }
  }
  let bytes = Buffer.concat(chunks);
  if (bytes.byteLength > maxBytes) {
    bytes = bytes.subarray(bytes.byteLength - maxBytes);
    dropped = true;
  }
  const text = bytes.toString("utf8");
  return dropped ? text.slice(text.indexOf("\n") + 1) : text;
}

/** repo 內的路徑（以 `/` 分隔）逐段編碼。 */
function contentPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
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

  async function createInstallationToken(
    installationId: number,
    scope?: TokenScope,
  ): Promise<InstallationToken> {
    const data = await must(
      request(
        "POST",
        `/app/installations/${installationId}/access_tokens`,
        { kind: "app" },
        TokenResponse,
        scope
          ? { body: { repository_ids: scope.repositoryIds, permissions: scope.permissions } }
          : {},
      ),
    );
    return { token: data.token, expiresAt: new Date(data.expires_at) };
  }

  const tokens = new InstallationTokenCache({
    fetchToken: (installationId) => createInstallationToken(installationId),
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

    async listInstallationRepositories(installationId) {
      const repos: { id: number; fullName: string }[] = [];
      let url: string | null = "/installation/repositories?per_page=100";
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const result = await request(
          "GET",
          url,
          inst(installationId),
          InstallationRepositoriesResponse,
        );
        if (!result) break;
        repos.push(...result.data.repositories.map((r) => ({ id: r.id, fullName: r.full_name })));
        url = nextPage(result.response.headers.get("link"));
      }
      return repos;
    },

    async getCollaboratorRole(installationId, repo, user) {
      const result = await request(
        "GET",
        `${repoPath(repo)}/collaborators/${encodeURIComponent(user.login)}/permission`,
        inst(installationId),
        PermissionResponse,
        { allowNotFound: true },
      );
      if (!result || result.data.user?.id !== user.id) return "none";
      const role = result.data.role_name ?? result.data.permission;
      return ROLES.has(role as RepoRole) ? (role as RepoRole) : "none";
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

    async listReviewComments(installationId, repo, pullNumber, reviewId) {
      // `GET /pulls/{n}/reviews/{id}/comments` 的回應沒有 line、start_line、side，
      // 所以列出 PR 的所有行內留言，再以 pull_request_review_id 過濾。
      const comments: GitHubReviewComment[] = [];
      let url: string | null = `${repoPath(repo)}/pulls/${pullNumber}/comments?per_page=100`;
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const result = await request(
          "GET",
          url,
          inst(installationId),
          z.array(ReviewCommentResponse),
        );
        if (!result) break;
        comments.push(
          ...result.data.filter((c) => c.pull_request_review_id === reviewId).map(toReviewComment),
        );
        url = nextPage(result.response.headers.get("link"));
      }
      return comments;
    },

    async listCheckSuites(installationId, repo, sha) {
      const suites: GitHubCheckSuite[] = [];
      let url: string | null =
        `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/check-suites?per_page=100`;
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const result = await request("GET", url, inst(installationId), CheckSuitesResponse);
        if (!result) break;
        suites.push(
          ...result.data.check_suites.map((s) => ({
            id: s.id,
            appSlug: s.app?.slug ?? "",
            status: s.status ?? "queued",
            conclusion: s.conclusion,
            latestCheckRunsCount: s.latest_check_runs_count ?? 0,
          })),
        );
        url = nextPage(result.response.headers.get("link"));
      }
      return suites;
    },

    async listCheckRuns(installationId, repo, sha) {
      const runs: GitHubCheckRun[] = [];
      let url: string | null =
        `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/check-runs?filter=latest&per_page=100`;
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const result = await request("GET", url, inst(installationId), CheckRunsResponse);
        if (!result) break;
        runs.push(
          ...result.data.check_runs.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            appSlug: r.app?.slug ?? "",
            htmlUrl: r.html_url ?? "",
            outputTitle: r.output?.title ?? null,
            outputSummary: r.output?.summary ?? null,
          })),
        );
        url = nextPage(result.response.headers.get("link"));
      }
      return runs;
    },

    async listCheckRunAnnotations(installationId, repo, checkRunId) {
      const annotations: GitHubCheckAnnotation[] = [];
      let url: string | null =
        `${repoPath(repo)}/check-runs/${checkRunId}/annotations?per_page=100`;
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const result = await request("GET", url, inst(installationId), AnnotationsResponse, {
          allowNotFound: true,
        });
        if (!result) break;
        annotations.push(
          ...result.data.map((a) => ({
            path: a.path,
            startLine: a.start_line ?? null,
            endLine: a.end_line ?? null,
            level: a.annotation_level ?? "notice",
            title: a.title || null,
            message: a.message,
          })),
        );
        url = nextPage(result.response.headers.get("link"));
      }
      return annotations;
    },

    async getActionsJobLog(installationId, repo, jobId) {
      // 回應是 302 轉到暫時的下載網址；fetch 會跟著轉址，跨網域轉址時不會帶上 authorization。
      const path = `${repoPath(repo)}/actions/jobs/${jobId}/logs`;
      const auth = inst(installationId);
      let response = await send("GET", path, auth);
      if (response.status === 401) {
        tokens.invalidate(installationId);
        response = await send("GET", path, auth);
      }
      if (response.status === 404 || response.status === 410) return null;
      if (!response.ok) {
        throw new GitHubApiError(
          response.status,
          `GitHub API GET ${path} 失敗：HTTP ${response.status}`,
        );
      }
      return readTail(response, MAX_JOB_LOG_BYTES);
    },

    async getBranchHead(installationId, repo, branch) {
      const result = await request(
        "GET",
        `${repoPath(repo)}/git/ref/heads/${contentPath(branch)}`,
        inst(installationId),
        RefResponse,
        { allowNotFound: true },
      );
      return result ? result.data.object.sha : null;
    },

    async createBranch(installationId, repo, branch, sha) {
      await must(
        request("POST", `${repoPath(repo)}/git/refs`, inst(installationId), RefResponse, {
          body: { ref: `refs/heads/${branch}`, sha },
        }),
      );
    },

    async getFileContent(installationId, repo, path, ref): Promise<GitHubFileContent | null> {
      const query = new URLSearchParams({ ref });
      const result = await request(
        "GET",
        `${repoPath(repo)}/contents/${contentPath(path)}?${query}`,
        inst(installationId),
        ContentResponse,
        { allowNotFound: true },
      );
      if (!result) return null;
      const data = result.data;
      if (data.type !== "file") throw new GitHubApiError(422, `${path} 不是檔案`);
      const content =
        data.encoding === "base64"
          ? Buffer.from((data.content ?? "").replace(/\s/g, ""), "base64").toString("utf8")
          : (data.content ?? "");
      return { sha: data.sha, content };
    },

    async putFile(installationId, repo, input) {
      const data = await must(
        request(
          "PUT",
          `${repoPath(repo)}/contents/${contentPath(input.path)}`,
          inst(installationId),
          PutFileResponse,
          {
            body: {
              message: input.message,
              content: Buffer.from(input.content, "utf8").toString("base64"),
              branch: input.branch,
              ...(input.sha ? { sha: input.sha } : {}),
            },
          },
        ),
      );
      return { commitSha: data.commit.sha, blobSha: data.content.sha };
    },
  };
}
