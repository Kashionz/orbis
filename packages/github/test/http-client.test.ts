// GitHubClient 的 fetch 實作：請求的形狀、認證、分頁、404 與 401 的處理。

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHttpGitHubClient, readTail } from "../src/client/http";
import { GitHubApiError } from "../src/client/types";
import { fixture } from "./helpers/world";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

interface Recorded {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

type Route = (req: Recorded) => Response | undefined;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function setup(routes: Route[]) {
  const requests: Recorded[] = [];
  const fetchFake: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const req: Recorded = {
      method: init?.method ?? "GET",
      url: String(input),
      authorization: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(req);
    for (const route of routes) {
      const response = route(req);
      if (response) return response;
    }
    return json({ message: "Not Found" }, { status: 404 });
  };
  const client = createHttpGitHubClient({
    appId: 99,
    privateKey,
    fetch: fetchFake,
    apiUrl: "https://gh.test",
  });
  return { client, requests };
}

const tokenRoute: Route = (req) =>
  req.method === "POST" && req.url.endsWith("/access_tokens")
    ? json(
        { token: `ghs_${req.url.split("/")[5]}`, expires_at: "2099-01-01T00:00:00Z" },
        { status: 201 },
      )
    : undefined;

const issue = fixture("issues.edited").issue;
const repo = { owner: "Codertocat", name: "Hello-World" };

describe("HTTP GitHubClient", () => {
  it("以 App JWT 查詢安裝狀態；沒有安裝時回傳 null", async () => {
    const { client, requests } = setup([
      (req) =>
        req.url.endsWith("/repos/Codertocat/Hello-World/installation")
          ? json({ id: 5 })
          : undefined,
    ]);
    expect(await client.findRepoInstallation(repo)).toEqual({ installationId: 5 });
    expect(await client.findRepoInstallation({ owner: "a", name: "b" })).toBeNull();
    expect(requests[0]?.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("以 installation token 呼叫 API，token 會被快取", async () => {
    const { client, requests } = setup([
      tokenRoute,
      (req) => (req.url.endsWith("/issues/1") && req.method === "GET" ? json(issue) : undefined),
    ]);
    const first = await client.getIssue(5, repo, 1);
    await client.getIssue(5, repo, 1);
    expect(first).toMatchObject({
      number: 1,
      title: issue.title,
      body: issue.body,
      labels: ["bug", "enhancement", "frontend"],
      assignees: [{ id: 13392701, login: "Kashionz", type: "User" }],
      isPullRequest: false,
    });
    expect(requests.filter((r) => r.url.endsWith("/access_tokens"))).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://gh.test/app/installations/5/access_tokens");
    expect(requests[1]?.authorization).toBe("token ghs_5");
  });

  it("installation token 回 401 時換新 token 重試一次", async () => {
    let issued = 0;
    const { client, requests } = setup([
      (req) =>
        req.url.endsWith("/access_tokens")
          ? json({ token: `ghs_${++issued}`, expires_at: "2099-01-01T00:00:00Z" }, { status: 201 })
          : undefined,
      (req) =>
        req.authorization === "token ghs_1"
          ? json({ message: "Bad credentials" }, { status: 401 })
          : undefined,
      (req) => (req.url.endsWith("/issues/1") ? json(issue) : undefined),
    ]);
    expect(await client.getIssue(5, repo, 1)).not.toBeNull();
    expect(requests.map((r) => r.authorization?.split(" ")[0])).toEqual([
      "Bearer",
      "token",
      "Bearer",
      "token",
    ]);
  });

  it("listOpenIssues 依 Link header 翻頁並排除 PR", async () => {
    const pr = { ...issue, number: 2, pull_request: { url: "x" } };
    const { client } = setup([
      tokenRoute,
      (req) =>
        req.url.includes("/issues?state=open")
          ? json([issue, pr], {
              headers: {
                link: '<https://gh.test/page2>; rel="next", <https://gh.test/page9>; rel="last"',
              },
            })
          : undefined,
      (req) => (req.url === "https://gh.test/page2" ? json([{ ...issue, number: 3 }]) : undefined),
    ]);
    const issues = await client.listOpenIssues(5, repo);
    expect(issues.map((i) => i.number)).toEqual([1, 3]);
  });

  it("updateIssue 把 stateReason 轉成 state_reason", async () => {
    const { client, requests } = setup([
      tokenRoute,
      (req) =>
        req.method === "PATCH"
          ? json({ ...issue, state: "closed", state_reason: "completed" })
          : undefined,
    ]);
    const updated = await client.updateIssue(5, repo, 1, {
      state: "closed",
      stateReason: "completed",
      title: "t",
    });
    expect(requests.at(-1)?.body).toEqual({
      state: "closed",
      state_reason: "completed",
      title: "t",
    });
    expect(updated).toMatchObject({ state: "closed", stateReason: "completed" });
  });

  it("updateIssueComment 在留言被刪除（404）時回傳 null", async () => {
    const { client } = setup([tokenRoute]);
    expect(await client.updateIssueComment(5, repo, 99, "x")).toBeNull();
  });

  it("findOpenPullRequest 用 owner:branch 查詢；createPullRequest 送出正確的 body", async () => {
    const pull = fixture("pull_request.opened").pull_request;
    const { client, requests } = setup([
      tokenRoute,
      (req) => (req.url.includes("/pulls?") ? json([]) : undefined),
      (req) =>
        req.method === "POST" && req.url.endsWith("/pulls")
          ? json(pull, { status: 201 })
          : undefined,
    ]);
    expect(await client.findOpenPullRequest(5, repo, "feature/x")).toBeNull();
    expect(new URL(requests.at(-1)?.url ?? "").searchParams.get("head")).toBe(
      "Codertocat:feature/x",
    );
    const created = await client.createPullRequest(5, repo, {
      title: "T",
      body: "B",
      head: "feature/x",
      base: "main",
    });
    expect(requests.at(-1)?.body).toEqual({
      title: "T",
      body: "B",
      head: "feature/x",
      base: "main",
    });
    expect(created).toMatchObject({ number: pull.number, state: "open", merged: false });
  });

  it("其他錯誤丟出 GitHubApiError，訊息含 GitHub 的說明", async () => {
    const { client } = setup([
      tokenRoute,
      (req) =>
        req.method === "POST" && req.url.endsWith("/issues")
          ? json({ message: "Validation Failed" }, { status: 422 })
          : undefined,
    ]);
    const error = await client
      .createIssue(5, repo, { title: "t", body: "", assignees: [], labels: [] })
      .catch((e) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error.status).toBe(422);
    expect(error.message).toContain("Validation Failed");
  });
  it("指定 scope 時簽發只限這些 repo 與權限的 token，不經過快取", async () => {
    const { client, requests } = setup([tokenRoute]);
    await client.createInstallationToken(5, {
      repositoryIds: [42],
      permissions: { contents: "write" },
    });
    await client.createInstallationToken(5, {
      repositoryIds: [42],
      permissions: { contents: "write" },
    });
    expect(requests.map((r) => r.body)).toEqual([
      { repository_ids: [42], permissions: { contents: "write" } },
      { repository_ids: [42], permissions: { contents: "write" } },
    ]);
  });

  it("getCollaboratorRole 回傳 role_name；不是 collaborator（404）時是 none", async () => {
    const { client } = setup([
      tokenRoute,
      (req) =>
        req.url.endsWith("/collaborators/alice/permission")
          ? json({ permission: "write", role_name: "maintain", user: { id: 11, login: "alice" } })
          : undefined,
    ]);
    expect(await client.getCollaboratorRole(5, repo, { login: "alice", id: 11 })).toBe("maintain");
    expect(await client.getCollaboratorRole(5, repo, { login: "nobody", id: 12 })).toBe("none");
    // login 已經屬於另一個帳號（改名後被別人註冊）
    expect(await client.getCollaboratorRole(5, repo, { login: "alice", id: 99 })).toBe("none");
  });
});

describe("readTail（job log 只讀最後的部分）", () => {
  function streamed(parts: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    });
    return new Response(body);
  }

  it("沒有超過上限時原樣回傳", async () => {
    expect(await readTail(streamed(["a\n", "b\n"]), 100)).toBe("a\nb\n");
  });

  it("超過上限時只保留最後的部分，並丟掉被截斷的第一行", async () => {
    const parts = Array.from({ length: 1000 }, (_, i) => `第 ${i} 行\n`);
    const text = await readTail(streamed(parts), 200);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(200);
    expect(text.endsWith("第 999 行\n")).toBe(true);
    expect(text.startsWith("第 ")).toBe(true);
    expect(text).not.toContain("第 0 行");
  });
});
