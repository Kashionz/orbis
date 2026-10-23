// Drizzle 版 GitHubStore（src/github/store.ts）跑 packages/github 匯出的 GitHubStore 契約測試。
//
// 契約測試用的是 `task-1`、`repo-1`、`run-1` 這類字串 ID，但資料表的這些欄位是 UUID 外鍵。
// 所以每次建立 store 時先建好對應的 Team、Project、Repo、Task、Run，再以一層轉換把契約測試的 ID
// 對應到真實的資料列（讀出時轉回去），讓 store 本身在真實的 Postgres 與外鍵限制下被測試。

import type { GitHubStore, IssueLink, PullRequestLink } from "@orbis/github";
import { describeGitHubStoreContract } from "@orbis/github/testing/store-contract";
import { afterAll, beforeAll, describe } from "vitest";
import { runs } from "../src/db/schema";
import { DrizzleGitHubStore } from "../src/github/store";
import { resetDatabase, seedProject, seedReadyTask, seedTeam } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";

/** 把契約測試的字串 ID 對應到真實資料列的 GitHubStore。 */
class MappedGitHubStore implements GitHubStore {
  constructor(
    private readonly inner: GitHubStore,
    private readonly ids: {
      task: Map<string, string>;
      repo: Map<string, string>;
      run: Map<string, string>;
    },
  ) {}

  private to(kind: "task" | "repo" | "run", id: string): string {
    const mapped = this.ids[kind].get(id);
    if (!mapped) throw new Error(`契約測試用到未準備的 ${kind}：${id}`);
    return mapped;
  }

  private from(kind: "task" | "repo" | "run", id: string): string {
    for (const [fake, real] of this.ids[kind]) if (real === id) return fake;
    throw new Error(`找不到 ${kind} ${id} 對應的契約 ID`);
  }

  private toLink = (link: IssueLink): IssueLink => ({
    ...link,
    taskId: this.to("task", link.taskId),
    repoId: this.to("repo", link.repoId),
  });

  private fromLink = (link: IssueLink): IssueLink => ({
    ...link,
    taskId: this.from("task", link.taskId),
    repoId: this.from("repo", link.repoId),
  });

  private toPull = (link: PullRequestLink): PullRequestLink => ({
    ...link,
    taskId: this.to("task", link.taskId),
    repoId: this.to("repo", link.repoId),
    runId: link.runId === null ? null : this.to("run", link.runId),
  });

  private fromPull = (link: PullRequestLink): PullRequestLink => ({
    ...link,
    taskId: this.from("task", link.taskId),
    repoId: this.from("repo", link.repoId),
    runId: link.runId === null ? null : this.from("run", link.runId),
  });

  claimDelivery: GitHubStore["claimDelivery"] = (input) => this.inner.claimDelivery(input);
  completeDelivery: GitHubStore["completeDelivery"] = (id, now) =>
    this.inner.completeDelivery(id, now);
  releaseDelivery: GitHubStore["releaseDelivery"] = (id) => this.inner.releaseDelivery(id);

  async getIssueLinkByTask(taskId: string) {
    const link = await this.inner.getIssueLinkByTask(this.to("task", taskId));
    return link && this.fromLink(link);
  }

  async findIssueLinks(githubRepoId: number, issueNumber: number) {
    return (await this.inner.findIssueLinks(githubRepoId, issueNumber)).map(this.fromLink);
  }

  saveIssueLink(link: IssueLink) {
    return this.inner.saveIssueLink(this.toLink(link));
  }

  deleteIssueLink(taskId: string) {
    return this.inner.deleteIssueLink(this.to("task", taskId));
  }

  async findPullRequestLink(githubRepoId: number, number: number) {
    const link = await this.inner.findPullRequestLink(githubRepoId, number);
    return link && this.fromPull(link);
  }

  savePullRequestLink(link: PullRequestLink) {
    return this.inner.savePullRequestLink(this.toPull(link));
  }
}

describe.skipIf(dbSkipReason !== null)("Drizzle GitHubStore", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  describeGitHubStoreContract("DrizzleGitHubStore", async () => {
    const db = database.db;
    await resetDatabase(db);
    const team = await seedTeam(db);
    // 兩個 Project 各有一個 Repo（契約測試的 repo-1、repo-2），Task 分別在兩個 Project。
    const first = await seedProject(db, team.teamId);
    const second = await seedProject(db, team.teamId, { taskKeyPrefix: "TWO" });
    const task1 = await seedReadyTask(db, first.project, first.repo.id);
    const task2 = await seedReadyTask(db, second.project, second.repo.id);
    const [run] = await db
      .insert(runs)
      .values({ taskId: task1.id, agent: "claude-code", permissionPolicy: "auto", target: "local" })
      .returning();
    if (!run) throw new Error("建立 Run 失敗");
    // 契約測試「同一個 Repo 中一個 Issue 只能對應一個 Task」會把 task-2 放在 repo-1：
    // DB 只檢查 (repo_id, issue_number)，不要求 Task 屬於那個 Repo。
    return new MappedGitHubStore(new DrizzleGitHubStore(db), {
      task: new Map([
        ["task-1", task1.id],
        ["task-2", task2.id],
      ]),
      repo: new Map([
        ["repo-1", first.repo.id],
        ["repo-2", second.repo.id],
      ]),
      run: new Map([["run-1", run.id]]),
    });
  });
});
