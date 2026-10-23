// 從 Issue 匯入成 Task。HTTP 端點由 Server 提供，測試在 apps/server/test/github-integration.test.ts。

import { describe, expect, it } from "vitest";
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

  it("兩個人同時匯入同一個 Issue：只建立一個對應，後到的一方回傳 already_linked", async () => {
    const w = createWorld();
    const issue = w.github.humanOpenIssue(w.repo.id, { title: "同時匯入" });
    const input = { repoId: REPO_ID, issueNumbers: [issue.number] };
    const [first, second] = await Promise.all([
      w.integration.importIssues({ ...input, importedByMemberId: w.alice.id }),
      w.integration.importIssues({ ...input, importedByMemberId: w.bob.id }),
    ]);
    const statuses = [first?.[0]?.status, second?.[0]?.status].sort();
    expect(statuses).toEqual(["already_linked", "imported"]);
    const links = await w.store.findIssueLinks(w.repo.id, issue.number);
    expect(links).toHaveLength(1);
    // 兩個請求都通過了「還沒匯入」的檢查，由 store 的唯一性擋下後到的一方
    expect(w.logger.entries.map((e) => e.msg)).toContain(
      "同一個 Issue 同時被匯入，這個 Task 沒有建立對應",
    );
    expect(
      [first?.[0], second?.[0]].every((r) => r && "taskId" in r && r.taskId === links[0]?.taskId),
    ).toBe(true);
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
