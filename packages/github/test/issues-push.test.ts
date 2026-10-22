// Orbis→GitHub：Task 的建立與修改同步到 Issue，以及狀態摘要留言。

import { describe, expect, it } from "vitest";
import { SUMMARY_MARKER } from "../src/markdown";
import { createWorld, REPO_ID } from "./helpers/world";

describe("Task 同步到 GitHub Issue", () => {
  it("有 Repo 的 Task 第一次同步時建立 Issue，欄位對應正確", async () => {
    const w = createWorld();
    const task = w.addTask({ labels: ["docs", "bug", "docs"], assigneeMemberId: w.alice.id });

    const outcome = await w.integration.onTaskChanged(task.id);

    expect(outcome).toMatchObject({ kind: "synced", created: true });
    const [issue] = w.github.issues.get(w.repo.id) ?? [];
    expect(issue).toMatchObject({
      title: task.title,
      body: task.description,
      state: "open",
      labels: ["bug", "docs"],
      assignees: [{ login: w.alice.githubLogin }],
    });
    const link = await w.store.getIssueLinkByTask(task.id);
    expect(link).toMatchObject({
      repoId: REPO_ID,
      githubRepoId: w.repo.id,
      issueNumber: issue?.number,
    });
  });

  it("沒有 Repo、Repo 沒安裝 App、Task 不存在時不呼叫 GitHub", async () => {
    const w = createWorld();
    const noRepo = w.addTask({ repoId: null });
    expect(await w.integration.onTaskChanged(noRepo.id)).toEqual({
      kind: "skipped",
      reason: "no_repo",
    });
    expect(await w.integration.onTaskChanged("missing")).toEqual({
      kind: "skipped",
      reason: "task_not_found",
    });
    await w.domain.updateRepoGitHubInfo(REPO_ID, { installationId: null });
    const task = w.addTask();
    expect(await w.integration.onTaskChanged(task.id)).toEqual({
      kind: "skipped",
      reason: "repo_not_connected",
    });
    expect(w.github.calls).toEqual([]);
  });

  it("Task 已經是 Done 時建立的 Issue 直接關閉", async () => {
    const w = createWorld();
    const task = w.addTask({ status: "done" });
    await w.integration.onTaskChanged(task.id);
    const [issue] = w.github.issues.get(w.repo.id) ?? [];
    expect(issue).toMatchObject({ state: "closed", stateReason: "completed" });
  });

  it("只寫出 Task 改過的欄位；沒有變化時不更新 Issue", async () => {
    const w = createWorld();
    const task = w.addTask();
    await w.integration.onTaskChanged(task.id);

    await w.integration.onTaskChanged(task.id);
    expect(w.github.callsTo("updateIssue")).toHaveLength(0);

    w.domain.editTask(task.id, { title: "新的標題", labels: ["p1"] });
    const outcome = await w.integration.onTaskChanged(task.id);
    expect(outcome).toMatchObject({ kind: "synced", created: false, wrote: ["title", "labels"] });
    const [call] = w.github.callsTo("updateIssue");
    expect(call?.args[3]).toEqual({ title: "新的標題", labels: ["p1"] });
  });

  it("Task 轉 Done 關閉 Issue，離開 Done 重新打開", async () => {
    const w = createWorld();
    const task = w.addTask();
    const { issueNumber } = (await w.integration.onTaskChanged(task.id)) as { issueNumber: number };

    w.domain.editTask(task.id, { status: "done" });
    await w.integration.onTaskChanged(task.id);
    expect(w.github.issue(w.repo.id, issueNumber)).toMatchObject({
      state: "closed",
      stateReason: "completed",
    });

    w.domain.editTask(task.id, { status: "backlog" });
    await w.integration.onTaskChanged(task.id);
    expect(w.github.issue(w.repo.id, issueNumber)).toMatchObject({
      state: "open",
      stateReason: "reopened",
    });
  });

  it("負責人改成別人、取消指派時更新 assignees", async () => {
    const w = createWorld();
    const task = w.addTask({ assigneeMemberId: w.alice.id });
    const { issueNumber } = (await w.integration.onTaskChanged(task.id)) as { issueNumber: number };

    w.domain.editTask(task.id, { assigneeMemberId: w.bob.id });
    await w.integration.onTaskChanged(task.id);
    expect(w.github.issue(w.repo.id, issueNumber).assignees.map((a) => a.login)).toEqual(["bob"]);

    w.domain.editTask(task.id, { assigneeMemberId: null });
    await w.integration.onTaskChanged(task.id);
    expect(w.github.issue(w.repo.id, issueNumber).assignees).toEqual([]);
  });

  it("GitHub 默默略過不能指派的 assignee 時，快照記錄實際結果，之後不會誤判", async () => {
    const w = createWorld();
    // carol 是 Member，但在 GitHub 上不能被指派（例如沒有 repo 權限）
    const carol = w.domain.addMember(
      { id: "member-carol", githubUserId: 4004, githubLogin: "carol" },
      ["project-1"],
    );
    const task = w.addTask({ assigneeMemberId: carol.id });
    await w.integration.onTaskChanged(task.id);
    const link = await w.store.getIssueLinkByTask(task.id);
    expect(link?.snapshot.assignee).toBeNull();
  });

  it("同時觸發多次同步只建立一個 Issue", async () => {
    const w = createWorld();
    const task = w.addTask();
    await Promise.all([1, 2, 3].map(() => w.integration.onTaskChanged(task.id)));
    expect(w.github.issues.get(w.repo.id)).toHaveLength(1);
    expect(w.github.commentsOn(w.repo.id, 1)).toHaveLength(1);
  });

  it("GitHub 回錯時丟出錯誤，下一次同步會重試", async () => {
    const w = createWorld();
    const task = w.addTask();
    w.github.failNext("createIssue");
    await expect(w.integration.onTaskChanged(task.id)).rejects.toThrow("Bad Gateway");
    expect(await w.store.getIssueLinkByTask(task.id)).toBeNull();
    await w.integration.onTaskChanged(task.id);
    expect(w.github.issues.get(w.repo.id)).toHaveLength(1);
  });
});

describe("狀態摘要留言", () => {
  it("建立 Issue 時留一則摘要，內容含 Task Key、狀態、Acceptance Criterion 與連結", async () => {
    const w = createWorld();
    const task = w.addTask({ status: "review_gate" });
    w.domain.criteria.set(task.id, [
      { kind: "command", description: "pnpm test 通過", result: "passed" },
      { kind: "manual", description: "UI | 看起來正常", result: "pending" },
    ]);
    w.domain.runs.set(task.id, { id: "run-1", agent: "claude-code", status: "succeeded" });

    await w.integration.onTaskChanged(task.id);

    const comments = w.github.commentsOn(w.repo.id, 1);
    expect(comments).toHaveLength(1);
    const body = comments[0]?.body ?? "";
    expect(body.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(body).toContain(`[${task.key}](https://pm.test/tasks/${task.key})`);
    expect(body).toContain("**狀態**：Review Gate");
    expect(body).toContain("claude-code · succeeded");
    expect(body).toContain("| pnpm test 通過 | `command` | ✅ 通過 |");
    expect(body).toContain("| UI \\| 看起來正常 | `manual` | ⏳ 未判定 |");
  });

  it("之後只更新同一則留言；內容沒變就不呼叫 API", async () => {
    const w = createWorld();
    const task = w.addTask();
    await w.integration.onTaskChanged(task.id);
    await w.integration.onTaskChanged(task.id);
    expect(w.github.callsTo("updateIssueComment")).toHaveLength(0);

    w.domain.editTask(task.id, { status: "running" });
    await w.integration.onTaskChanged(task.id);
    w.domain.criteria.set(task.id, [{ kind: "command", description: "lint", result: "failed" }]);
    await w.integration.onTaskChanged(task.id);

    const comments = w.github.commentsOn(w.repo.id, 1);
    expect(comments).toHaveLength(1);
    expect(w.github.callsTo("createIssueComment")).toHaveLength(1);
    expect(w.github.callsTo("updateIssueComment")).toHaveLength(2);
    expect(comments[0]?.body).toContain("❌ 失敗");
  });

  it("摘要留言被刪除後，下一次同步重建一則（不重複）", async () => {
    const w = createWorld();
    const task = w.addTask();
    await w.integration.onTaskChanged(task.id);
    const [comment] = w.github.commentsOn(w.repo.id, 1);
    w.github.humanDeleteComment(w.repo.id, comment?.id ?? 0);

    w.domain.editTask(task.id, { status: "ready" });
    await w.integration.onTaskChanged(task.id);

    const comments = w.github.commentsOn(w.repo.id, 1);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).not.toBe(comment?.id);
    expect((await w.store.getIssueLinkByTask(task.id))?.summaryCommentId).toBe(comments[0]?.id);
  });
});
