// 同一個 repo 登記在兩個 Project，同一個 Issue 對應到兩個 Task（ARCHITECTURE §11）：
// 各有一則摘要留言；title、body、state 經由 Issue 在 Task 之間同步；labels、負責人各自管理。

import { describe, expect, it } from "vitest";
import { createWorld, REPO_ID, type World } from "./helpers/world";

const OTHER_PROJECT = "project-2";
const OTHER_REPO = "repo-2";

/** Project 1 的 Task A 建立 Issue，Project 2 匯入同一個 Issue 成為 Task B。 */
async function sharedIssue(w: World = createWorld()) {
  w.domain.addRepo({ ...w.domain.repo(REPO_ID), id: OTHER_REPO, projectId: OTHER_PROJECT });
  for (const member of [w.alice, w.bob])
    w.domain.members.get(member.id)?.projectIds.push(OTHER_PROJECT);

  const a = w.addTask({ title: "共同的 Issue", description: "原本的內容" });
  const pushed = await w.integration.onTaskChanged(a.id);
  if (pushed.kind !== "synced") throw new Error("同步失敗");
  const [imported] = await w.integration.importIssues({
    repoId: OTHER_REPO,
    issueNumbers: [pushed.issueNumber],
    importedByMemberId: w.bob.id,
  });
  if (imported?.status !== "imported") throw new Error("匯入失敗");
  const b = w.domain.task(imported.taskId);
  w.github.calls.length = 0;
  w.domain.fieldUpdates.length = 0;
  return { w, a, b, issueNumber: pushed.issueNumber };
}

describe("同一個 Issue 對應到不同 Project 的 Task", () => {
  it("每個 Task 各有一則狀態摘要留言", async () => {
    const { w, a, b, issueNumber } = await sharedIssue();
    const comments = w.github.commentsOn(w.repo.id, issueNumber);
    expect(comments).toHaveLength(2);
    expect(comments.map((c) => c.body).join("\n")).toContain(a.key);
    expect(comments.map((c) => c.body).join("\n")).toContain(b.key);
  });

  it("在 GitHub 上關閉 Issue：兩個 Task 都轉 Done", async () => {
    const { w, a, b, issueNumber } = await sharedIssue();
    const issue = w.github.humanEdit(w.repo.id, issueNumber, { state: "closed" });
    await w.deliver("issues", w.issuePayload("closed", issue, w.userRef(w.bob)));
    expect(w.domain.task(a.id).status).toBe("done");
    expect(w.domain.task(b.id).status).toBe("done");
  });

  it("Task A 改 title 與描述：寫到 Issue，Task B 也跟著更新", async () => {
    const { w, a, b, issueNumber } = await sharedIssue();
    w.domain.editTask(a.id, { title: "新的標題", description: "新的內容" });
    await w.integration.onTaskChanged(a.id);

    expect(w.github.issue(w.repo.id, issueNumber)).toMatchObject({
      title: "新的標題",
      body: "新的內容",
    });
    expect(w.domain.task(b.id)).toMatchObject({ title: "新的標題", description: "新的內容" });
    // B 的快照已經是 Issue 的值，B 之後同步時不會再寫一次
    w.github.calls.length = 0;
    await w.integration.onTaskChanged(b.id);
    expect(w.github.callsTo("updateIssue")).toHaveLength(0);
  });

  it("Task A 轉 Done 關閉 Issue：Task B 也轉 Done，關閉原因相同", async () => {
    const { w, a, b } = await sharedIssue();
    w.domain.editTask(a.id, { status: "done", doneReason: "not_planned" });
    await w.integration.onTaskChanged(a.id);
    expect(w.domain.task(b.id)).toMatchObject({ status: "done", doneReason: "not_planned" });
    expect(w.domain.transitions).toMatchObject([
      { taskId: b.id, to: "done", cause: { kind: "issue_closed", doneReason: "not_planned" } },
    ]);
  });

  it("PR merge 讓 Task A 轉 Done：Task B 也轉 Done", async () => {
    const { w, a, b } = await sharedIssue();
    w.domain.editTask(a.id, { status: "pr_open" });
    const opened = await w.integration.onBranchPushed({
      taskId: a.id,
      runId: "run-1",
      branch: `feature/${a.key}`,
      commitSha: "a".repeat(40),
    });
    if (!opened.ok) throw new Error(opened.message);
    await w.deliver(
      "pull_request",
      w.pullRequestPayload("closed", opened.number, { merged: true, sender: w.userRef(w.bob) }),
    );
    expect(w.domain.task(a.id).status).toBe("done");
    expect(w.domain.task(b.id).status).toBe("done");
  });

  it("Task B 有進行中的 Run：B 維持原狀態並在 B 的摘要留言說明，Issue 不會被改回來", async () => {
    const { w, a, b, issueNumber } = await sharedIssue();
    w.domain.editTask(b.id, { status: "running" });
    w.domain.activeRunTaskIds.add(b.id);
    w.domain.editTask(a.id, { status: "done" });
    await w.integration.onTaskChanged(a.id);

    expect(w.domain.task(b.id).status).toBe("running");
    expect(w.github.issue(w.repo.id, issueNumber).state).toBe("closed");
    const link = await w.store.getIssueLinkByTask(b.id);
    const summary = w.github
      .commentsOn(w.repo.id, issueNumber)
      .find((c) => c.id === link?.summaryCommentId);
    expect(summary?.body).toContain(`另一個 Project 的 Task ${a.key}`);
  });

  it("labels 不會在 Task 之間同步", async () => {
    const { w, a, b } = await sharedIssue();
    w.domain.editTask(a.id, { labels: ["p1"] });
    await w.integration.onTaskChanged(a.id);
    expect(w.domain.task(b.id).labels).toEqual([]);
    expect(w.domain.fieldUpdates.filter((u) => u.taskId === b.id)).toEqual([]);
  });
});
