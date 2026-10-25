// GitHub App 整合（packages/github）掛在 Server 上的行為：Server 的 DomainService、Drizzle 版
// GitHubStore 與 domain event 的訂閱，搭配 D 軌的 FakeGitHub 與錄製的真實 webhook payload。

import {
  API_ROUTES,
  apiPath,
  ImportableIssue,
  ImportIssueResult,
  NAMES,
  Repo,
  Task,
} from "@orbis/api-contract";
import type { GitHubIssue, GitHubUserRef } from "@orbis/github";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { pullRequests, repos, runs, taskIssueLinks, tasks } from "../src/db/schema";
import {
  client,
  createTestContext,
  expectContract,
  resetDatabase,
  type SeededTeam,
  seedTeam,
  type TestContext,
} from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import { createFakeGitHubApp, type FakeGitHubApp, fixture } from "./helpers/github";

const GITHUB_REPO_ID = 4242;
const INSTALLATION_ID = 77;

describe.skipIf(dbSkipReason !== null)("GitHub App 整合", () => {
  let database: TestDatabase;
  let ctx: TestContext;
  let gh: FakeGitHubApp;
  let team: SeededTeam;
  let memberOnGitHub: GitHubUserRef;
  let projectId: string;
  let repoId: string;

  const as = (role: keyof SeededTeam["members"]) => client(ctx.app, team.members[role].cookie);

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    gh = createFakeGitHubApp();
    ctx = createTestContext(database.db, { github: { app: gh.options } });
    team = await seedTeam(database.db);
    gh.addMember(team.members.admin, "write");
    memberOnGitHub = gh.addMember(team.members.member, "write");
    gh.github.addRepo({
      id: GITHUB_REPO_ID,
      owner: "acme",
      name: "app",
      defaultBranch: "main",
      installationId: INSTALLATION_ID,
    });
    const project = await as("admin").post<{ id: string }>("/api/projects", {
      name: "Dogfood",
      keyPrefix: "ORB",
    });
    projectId = project.body.id;
    const repo = await as("admin").post(
      apiPath(API_ROUTES.projectRepos, { projectId: project.body.id }),
      { owner: "acme", name: "app" },
    );
    expect(expectContract(Repo, repo.body).github?.installed).toBe(true);
    repoId = expectContract(Repo, repo.body).id;
  });

  async function createTask(title = "新增登入頁") {
    const res = await as("member").post(apiPath(API_ROUTES.projectTasks, { projectId }), {
      repoId,
      title,
      description: "用 GitHub 登入",
    });
    expect(res.status).toBe(201);
    await ctx.services.githubIdle();
    return expectContract(Task, res.body);
  }

  async function getTask(taskId: string) {
    return expectContract(Task, (await as("viewer").get(`/api/tasks/${taskId}`)).body);
  }

  async function issueOf(taskId: string): Promise<GitHubIssue> {
    const [link] = await database.db
      .select()
      .from(taskIssueLinks)
      .where(eq(taskIssueLinks.taskId, taskId));
    if (!link) throw new Error("Task 沒有對應的 Issue");
    return gh.github.issue(GITHUB_REPO_ID, link.issueNumber);
  }

  /** 以錄製的 `issues.<action>` 為底組出 payload（同 packages/github 的測試）。 */
  function issuePayload(action: string, issue: GitHubIssue, sender: GitHubUserRef) {
    const payload = fixture(`issues.${action}`);
    const userBase = payload.sender as Record<string, unknown>;
    const user = (u: GitHubUserRef) => ({ ...userBase, id: u.id, login: u.login, type: u.type });
    payload.issue = {
      ...payload.issue,
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body === "" ? null : issue.body,
      state: issue.state,
      state_reason: issue.stateReason,
      assignee: issue.assignees[0] ? user(issue.assignees[0]) : null,
      assignees: issue.assignees.map(user),
      labels: [],
      updated_at: issue.updatedAt,
      html_url: issue.htmlUrl,
    };
    payload.repository = {
      ...payload.repository,
      id: GITHUB_REPO_ID,
      name: "app",
      owner: { ...payload.repository.owner, login: "acme" },
    };
    payload.installation = { ...payload.installation, id: INSTALLATION_ID };
    payload.sender = user(sender);
    return payload;
  }

  async function deliver(event: string, payload: unknown) {
    const res = await ctx.app.request(API_ROUTES.githubWebhook, gh.webhook(event, payload));
    await ctx.services.githubIdle();
    return res;
  }

  describe("webhook", () => {
    it("簽章正確才接受（不處理的事件回 202）；簽章錯誤回 401", async () => {
      expect((await deliver("ping", fixture("ping"))).status).toBe(202);
      const bad = await ctx.app.request(API_ROUTES.githubWebhook, {
        ...gh.webhook("ping", fixture("ping")),
        headers: {
          "x-github-event": "ping",
          "x-github-delivery": "forged",
          "x-hub-signature-256": "sha256=00",
        },
      });
      expect(bad.status).toBe(401);
    });

    it("沒有設定 GitHub App 時 webhook 回 404，匯入回 409", async () => {
      const plain = createTestContext(database.db);
      const res = await plain.app.request(API_ROUTES.githubWebhook, gh.webhook("ping", {}));
      expect(res.status).toBe(404);
      const list = await client(plain.app, team.members.member.cookie).get(
        apiPath(API_ROUTES.repoImportableIssues, { repoId }),
      );
      expect(list.status).toBe(409);
      expect(list.body).toMatchObject({ error: "github_disabled" });
    });
  });

  describe("Task → Issue", () => {
    it("建立 Task 後在背景建立 Issue，修改 Task 後同步到 Issue", async () => {
      const task = await createTask();
      const issue = await issueOf(task.id);
      expect(issue).toMatchObject({ title: "新增登入頁", state: "open" });

      await as("member").patch(`/api/tasks/${task.id}`, { title: "新增登入頁（含 2FA）" });
      await ctx.services.githubIdle();
      expect((await issueOf(task.id)).title).toBe("新增登入頁（含 2FA）");
    });

    it("Project 關閉「自動建立 Issue」時不建立 Issue", async () => {
      await as("admin").patch(`/api/projects/${projectId}`, {
        policy: { autoCreateIssues: false },
      });
      const task = await createTask();
      expect(
        await database.db.select().from(taskIssueLinks).where(eq(taskIssueLinks.taskId, task.id)),
      ).toHaveLength(0);
    });
  });

  describe("Issue → Task", () => {
    it("Issue 以 not planned 關閉 → Task Done 並記下關閉原因；重開 → Backlog、清空原因", async () => {
      const task = await createTask();
      const { number } = await issueOf(task.id);
      const closed = gh.github.humanEdit(GITHUB_REPO_ID, number, {
        state: "closed",
        stateReason: "not_planned",
      });
      expect((await deliver("issues", issuePayload("closed", closed, memberOnGitHub))).status).toBe(
        200,
      );
      expect(await getTask(task.id)).toMatchObject({ status: "done", doneReason: "not_planned" });

      const reopened = gh.github.humanEdit(GITHUB_REPO_ID, number, { state: "open" });
      await deliver("issues", issuePayload("reopened", reopened, memberOnGitHub));
      expect(await getTask(task.id)).toMatchObject({ status: "backlog", doneReason: null });
    });

    it("Task 有進行中的 Run 時，Issue 關閉不會讓 Task 轉 Done", async () => {
      const task = await createTask();
      await database.db.update(tasks).set({ status: "running" }).where(eq(tasks.id, task.id));
      await database.db.insert(runs).values({
        taskId: task.id,
        agent: "claude-code",
        permissionPolicy: "auto",
        target: "local",
      });
      const { number } = await issueOf(task.id);
      const closed = gh.github.humanEdit(GITHUB_REPO_ID, number, { state: "closed" });
      await deliver("issues", issuePayload("closed", closed, memberOnGitHub));
      expect((await getTask(task.id)).status).toBe("running");
      // D 軌把 Issue 重新打開並在摘要留言說明。
      expect((await issueOf(task.id)).state).toBe("open");
    });

    it("Issue 改標題 → Task 的標題更新（不再同步回 GitHub）", async () => {
      const task = await createTask();
      const { number } = await issueOf(task.id);
      const updateCalls = gh.github.callsTo("updateIssue").length;
      const edited = gh.github.humanEdit(GITHUB_REPO_ID, number, { title: "GitHub 上改的標題" });
      await deliver("issues", {
        ...issuePayload("edited", edited, memberOnGitHub),
        changes: { title: { from: "新增登入頁" } },
      });
      expect((await getTask(task.id)).title).toBe("GitHub 上改的標題");
      expect(gh.github.callsTo("updateIssue")).toHaveLength(updateCalls);
    });
  });

  describe("PR", () => {
    async function openPullRequest() {
      const task = await createTask();
      await database.db.update(tasks).set({ status: "pr_open" }).where(eq(tasks.id, task.id));
      const [run] = await database.db
        .insert(runs)
        .values({
          taskId: task.id,
          agent: "claude-code",
          permissionPolicy: "auto",
          target: "local",
          status: "completed",
        })
        .returning();
      if (!run) throw new Error("建立 Run 失敗");
      const opened = await ctx.services.github.pullRequestOpener.openPullRequest({
        taskId: task.id,
        runId: run.id,
        branch: `${NAMES.branchPrefix}ORB-1-login`,
        commitSha: "b".repeat(40),
      });
      expect(opened).toMatchObject({ ok: true });
      const [pull] = gh.github.pulls.get(GITHUB_REPO_ID) ?? [];
      if (!pull) throw new Error("沒有開出 PR");
      return { task, run, pull };
    }

    function pullPayload(action: "closed" | "reopened", number: number, merged: boolean) {
      const payload = fixture(`pull_request.${action}`);
      const pull = gh.github.pulls.get(GITHUB_REPO_ID)?.find((p) => p.number === number);
      payload.number = number;
      payload.pull_request = {
        ...payload.pull_request,
        number,
        html_url: `https://github.com/acme/app/pull/${number}`,
        state: action === "reopened" ? "open" : "closed",
        merged,
        head: { ...payload.pull_request.head, ref: pull?.headRef, sha: pull?.headSha },
      };
      payload.repository = { ...payload.repository, id: GITHUB_REPO_ID, name: "app" };
      payload.installation = { ...payload.installation, id: INSTALLATION_ID };
      payload.sender = {
        ...payload.sender,
        id: memberOnGitHub.id,
        login: memberOnGitHub.login,
        type: "User",
      };
      return payload;
    }

    it("Runner push 後以 App 開 PR 並記下對應；PR merge → Task Done（completed）", async () => {
      const { task, run, pull } = await openPullRequest();
      const [link] = await database.db.select().from(pullRequests);
      expect(link).toMatchObject({ taskId: task.id, runId: run.id, number: pull.number });
      await deliver("pull_request", pullPayload("closed", pull.number, true));
      expect(await getTask(task.id)).toMatchObject({ status: "done", doneReason: "completed" });
    });

    it("PR 沒有 merge 就關閉 → Review Gate；重開 → PR Open", async () => {
      const { task, pull } = await openPullRequest();
      await deliver("pull_request", pullPayload("closed", pull.number, false));
      expect((await getTask(task.id)).status).toBe("review_gate");
      await deliver("pull_request", pullPayload("reopened", pull.number, false));
      expect((await getTask(task.id)).status).toBe("pr_open");
    });
  });

  describe("從 Issue 匯入", () => {
    it("列出可匯入的 Issue，匯入後成為 Backlog 的 Task；重複匯入回 already_linked", async () => {
      const issue = gh.github.humanOpenIssue(GITHUB_REPO_ID, { title: "從 GitHub 來的需求" });
      const listPath = apiPath(API_ROUTES.repoImportableIssues, { repoId });
      const list = expectContract(
        z.array(ImportableIssue),
        (await as("member").get(listPath)).body,
      );
      expect(list.map((i) => i.number)).toEqual([issue.number]);

      const importPath = apiPath(API_ROUTES.repoImportIssues, { repoId });
      const res = await as("member").post(importPath, { issueNumbers: [issue.number] });
      expect(res.status).toBe(200);
      const [result] = expectContract(z.array(ImportIssueResult), res.body);
      expect(result).toMatchObject({ issueNumber: issue.number, status: "imported" });
      const task = await getTask(result?.taskId ?? "");
      expect(task).toMatchObject({
        title: "從 GitHub 來的需求",
        status: "backlog",
        key: "ORB-1",
        createdByMemberId: team.members.member.id,
      });

      const again = await as("member").post(importPath, { issueNumbers: [issue.number] });
      expect(expectContract(z.array(ImportIssueResult), again.body)[0]).toMatchObject({
        status: "already_linked",
        taskId: task.id,
      });
      expect((await as("member").get(listPath)).body).toEqual([]);
    });

    it("Viewer 不能匯入；其他 Team 的 Repo 找不到；輸入格式錯誤回 400", async () => {
      const importPath = apiPath(API_ROUTES.repoImportIssues, { repoId });
      expect((await as("viewer").post(importPath, { issueNumbers: [1] })).status).toBe(403);
      expect(
        (await as("viewer").get(apiPath(API_ROUTES.repoImportableIssues, { repoId }))).status,
      ).toBe(403);
      const other = await seedTeam(database.db, "Other");
      expect(
        (await client(ctx.app, other.members.owner.cookie).post(importPath, { issueNumbers: [1] }))
          .status,
      ).toBe(404);
      expect((await as("member").post(importPath, { issueNumbers: [] })).status).toBe(400);
    });

    it("Repo 還沒有安裝 App 時回 409 repo_not_connected", async () => {
      await database.db
        .update(repos)
        .set({ githubInstallationId: null })
        .where(eq(repos.id, repoId));
      const res = await as("member").get(apiPath(API_ROUTES.repoImportableIssues, { repoId }));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: "repo_not_connected" });
    });
  });

  describe("App 安裝狀態", () => {
    it("App 安裝之前登記的 Repo，在安裝事件中以名稱綁定並補上 repo id 與 default branch", async () => {
      const later = gh.github.addRepo({
        id: 5151,
        owner: "acme",
        name: "later",
        defaultBranch: "develop",
        installationId: null,
      });
      const created = await as("admin").post(apiPath(API_ROUTES.projectRepos, { projectId }), {
        owner: "acme",
        name: "later",
      });
      expect(expectContract(Repo, created.body)).toMatchObject({
        defaultBranch: "main",
        github: { installed: false },
      });

      later.installationId = 88;
      const payload = fixture("installation.created");
      payload.installation = { ...payload.installation, id: 88 };
      payload.repositories = [
        { ...payload.repositories[0], id: later.id, name: "later", full_name: "acme/later" },
      ];
      const admin = {
        id: team.members.admin.githubUserId,
        login: `user${team.members.admin.githubUserId}`,
      };
      payload.sender = { ...payload.sender, ...admin, type: "User" };
      expect((await deliver("installation", payload)).status).toBe(200);

      const list = expectContract(
        z.array(Repo),
        (await as("viewer").get(apiPath(API_ROUTES.projectRepos, { projectId }))).body,
      );
      expect(list.find((r) => r.name === "later")).toMatchObject({
        defaultBranch: "develop",
        github: { installed: true, installUrl: null },
      });
      const [row] = await database.db.select().from(repos).where(eq(repos.githubName, "later"));
      expect(row).toMatchObject({ githubRepoId: 5151, githubInstallationId: 88 });
    });
  });
});
