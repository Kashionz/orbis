// 從 Issue 匯入成 Task，以及 /api/github 的路由。

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createGitHubApiRoutes } from "../src/routes";
import { createWorld, PROJECT_ID, REPO_ID } from "./helpers/world";

describe("從 Issue 匯入", () => {
  it("列出還沒匯入的 open Issue（不含 PR、不含已關閉）", async () => {
    const w = createWorld();
    const a = w.github.humanOpenIssue(w.repo.id, {
      title: "A",
      labels: ["bug"],
      assignees: ["bob"],
    });
    const b = w.github.humanOpenIssue(w.repo.id, { title: "B" });
    w.github.humanEdit(w.repo.id, b.number, { state: "closed" });
    const task = w.addTask();
    await w.integration.onTaskChanged(task.id); // 已經對應的 Issue
    const issues = await w.integration.listImportableIssues(REPO_ID);
    expect(issues).toEqual([
      {
        number: a.number,
        title: "A",
        url: a.htmlUrl,
        labels: ["bug"],
        assignees: ["bob"],
        updatedAt: a.updatedAt,
      },
    ]);
  });

  it("匯入建立 Task 與對應，欄位與負責人正確，並留下摘要留言", async () => {
    const w = createWorld();
    const issue = w.github.humanOpenIssue(w.repo.id, {
      title: "從 GitHub 來的",
      body: "內容\r\n第二行",
      labels: ["z", "a"],
      assignees: ["outsider", "Codertocat"],
    });

    const results = await w.integration.importIssues({
      repoId: REPO_ID,
      issueNumbers: [issue.number],
      importedByMemberId: w.bob.id,
    });

    expect(results).toEqual([{ issueNumber: issue.number, status: "imported", taskId: "task-1" }]);
    expect(w.domain.createdFromIssue).toMatchObject([
      {
        projectId: PROJECT_ID,
        repoId: REPO_ID,
        title: "從 GitHub 來的",
        description: "內容\n第二行",
        labels: ["a", "z"],
        assigneeMemberId: w.alice.id,
        createdByMemberId: w.bob.id,
        status: "backlog",
      },
    ]);
    expect(await w.store.getIssueLinkByTask("task-1")).toMatchObject({ issueNumber: issue.number });
    expect(w.github.commentsOn(w.repo.id, issue.number)).toHaveLength(1);
    // 匯入不會改寫 Issue 本身（內容已經一致）
    expect(w.github.callsTo("updateIssue")).toEqual([]);
    expect(w.github.callsTo("createIssue")).toEqual([]);
  });

  it("重複匯入同一個 Issue 回傳原本的 Task，不重複建立", async () => {
    const w = createWorld();
    const issue = w.github.humanOpenIssue(w.repo.id, { title: "X" });
    const input = {
      repoId: REPO_ID,
      issueNumbers: [issue.number, issue.number],
      importedByMemberId: w.bob.id,
    };
    await w.integration.importIssues(input);
    const again = await w.integration.importIssues(input);
    expect(again).toEqual([
      { issueNumber: issue.number, status: "already_linked", taskId: "task-1" },
    ]);
    expect(w.domain.createdFromIssue).toHaveLength(1);
    expect(w.github.commentsOn(w.repo.id, issue.number)).toHaveLength(1);
  });

  it("不存在的 Issue、PR、已關閉的 Issue 不匯入", async () => {
    const w = createWorld();
    const pr = w.addTask();
    await w.integration.onBranchPushed({
      taskId: pr.id,
      runId: "r",
      branch: "b",
      commitSha: "a".repeat(40),
    });
    const prNumber = (w.github.pulls.get(w.repo.id) ?? [])[0]?.number ?? 0;
    const closed = w.github.humanOpenIssue(w.repo.id, { title: "C" });
    w.github.humanEdit(w.repo.id, closed.number, { state: "closed" });

    const results = await w.integration.importIssues({
      repoId: REPO_ID,
      issueNumbers: [999, prNumber, closed.number],
      importedByMemberId: w.bob.id,
    });
    expect(results).toEqual([
      { issueNumber: 999, status: "not_found" },
      { issueNumber: prNumber, status: "not_found" },
      { issueNumber: closed.number, status: "closed" },
    ]);
    expect(w.domain.createdFromIssue).toEqual([]);
  });

  it("Project 關閉「自動建立 Issue」時仍然可以匯入，並留下摘要留言", async () => {
    const w = createWorld();
    w.domain.autoCreateDisabledProjectIds.add(PROJECT_ID);
    const issue = w.github.humanOpenIssue(w.repo.id, { title: "從 GitHub 來的" });
    const [result] = await w.integration.importIssues({
      repoId: REPO_ID,
      issueNumbers: [issue.number],
      importedByMemberId: w.bob.id,
    });
    expect(result).toMatchObject({ status: "imported" });
    expect(w.github.commentsOn(w.repo.id, issue.number)).toHaveLength(1);
  });

  it("匯入之後在 GitHub 上的修改會同步回 Task", async () => {
    const w = createWorld();
    const issue = w.github.humanOpenIssue(w.repo.id, { title: "原標題" });
    await w.integration.importIssues({
      repoId: REPO_ID,
      issueNumbers: [issue.number],
      importedByMemberId: w.bob.id,
    });
    const edited = w.github.humanEdit(w.repo.id, issue.number, { title: "改過的標題" });
    await w.deliver("issues", w.issuePayload("edited", edited, w.userRef(w.bob)));
    expect(w.domain.task("task-1").title).toBe("改過的標題");
  });
});

describe("/api/github 路由", () => {
  /** bob 只能管理 PROJECT_ID 與它的 Repo；`loggedIn` 為 false 時 authenticate 擋下。 */
  function app(loggedIn = true) {
    const w = createWorld();
    const checked: string[] = [];
    const routes = createGitHubApiRoutes({
      github: w.integration,
      authenticate: async (c, next) => {
        if (!loggedIn) return c.json({ error: "unauthenticated" }, 401);
        await next();
      },
      memberIdOf: () => w.bob.id,
      canManageRepos: async (_c, projectId) => {
        checked.push(`project:${projectId}`);
        return projectId === PROJECT_ID;
      },
      canCreateTasksInRepo: async (_c, repoId) => {
        checked.push(`repo:${repoId}`);
        return w.domain.repos.get(repoId)?.projectId === PROJECT_ID;
      },
    });
    return { w, checked, app: new Hono().route("/api/github", routes) };
  }

  it("沒有登入時由 authenticate 擋下", async () => {
    const { app: api } = app(false);
    expect(
      (await api.request(`/api/github/repos/inspect?projectId=${PROJECT_ID}&owner=a&name=b`))
        .status,
    ).toBe(401);
    expect((await api.request(`/api/github/repos/${REPO_ID}/importable-issues`)).status).toBe(401);
  });

  it("沒有該 Project／Repo 的權限時回 403，不呼叫 GitHub", async () => {
    const { w, checked, app: api } = app();
    w.domain.addRepo({ ...w.domain.repo(REPO_ID), id: "repo-other", projectId: "project-other" });
    const inspect = await api.request(
      "/api/github/repos/inspect?projectId=project-other&owner=a&name=b",
    );
    expect(inspect.status).toBe(403);
    expect((await api.request("/api/github/repos/repo-other/importable-issues")).status).toBe(403);
    const imported = await api.request("/api/github/repos/repo-other/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issueNumbers: [1] }),
    });
    expect(imported.status).toBe(403);
    expect(checked).toEqual(["project:project-other", "repo:repo-other", "repo:repo-other"]);
    expect(w.github.calls).toEqual([]);
    expect(w.domain.createdFromIssue).toEqual([]);
  });

  it("GET /repos/inspect", async () => {
    const { w, app: api } = app();
    const response = await api.request(
      `/api/github/repos/inspect?projectId=${PROJECT_ID}&owner=${w.repo.owner}&name=${w.repo.name}`,
    );
    expect(await response.json()).toMatchObject({ installed: true, defaultBranch: "main" });
    expect(
      (await api.request(`/api/github/repos/inspect?projectId=${PROJECT_ID}&owner=a`)).status,
    ).toBe(400);
  });

  it("GET importable-issues 與 POST import", async () => {
    const { w, app: api } = app();
    const issue = w.github.humanOpenIssue(w.repo.id, { title: "要匯入的" });
    const list = await api.request(`/api/github/repos/${REPO_ID}/importable-issues`);
    expect(await list.json()).toMatchObject({ issues: [{ number: issue.number }] });

    const imported = await api.request(`/api/github/repos/${REPO_ID}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issueNumbers: [issue.number] }),
    });
    expect(await imported.json()).toEqual({
      results: [{ issueNumber: issue.number, status: "imported", taskId: "task-1" }],
    });
    expect(w.domain.createdFromIssue[0]?.createdByMemberId).toBe(w.bob.id);

    const bad = await api.request(`/api/github/repos/${REPO_ID}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issueNumbers: [] }),
    });
    expect(bad.status).toBe(400);
  });

  it("Repo 沒有安裝 App 時回 409", async () => {
    const { w, app: api } = app();
    await w.domain.updateRepoGitHubInfo(REPO_ID, { installationId: null });
    const response = await api.request(`/api/github/repos/${REPO_ID}/importable-issues`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "repo_not_connected" });
  });
});
