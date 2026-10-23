// 開 PR（Review Gate 核准、Runner push 完成後）與 pull_request webhook。

import { describe, expect, it } from "vitest";
import { PULL_REQUEST_MARKER } from "../src/markdown";
import { createWorld, fixture, REPO_ID, type World } from "./helpers/world";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** 送給 createPullRequest 的參數（第一次呼叫）。 */
function createdPullRequest(w: World) {
  const call = w.github.callsTo("createPullRequest")[0];
  if (!call) throw new Error("沒有開 PR");
  return call.args[2] as { title: string; body: string; head: string; base: string };
}

async function openedPr(w: World, overrides = {}) {
  const task = w.addTask({ status: "pr_open", assigneeMemberId: w.alice.id, ...overrides });
  const result = await w.integration.onBranchPushed({
    taskId: task.id,
    runId: "run-1",
    branch: `feature/${task.key}`,
    commitSha: SHA,
  });
  if (!result.ok) throw new Error(result.message);
  return { task, number: result.number };
}

describe("開 PR", () => {
  it("以 Task Key 加 title 為標題，body 含 Spec 摘要、Acceptance Criterion 結果與 Task 連結", async () => {
    const w = createWorld();
    const task = w.addTask({
      status: "pr_open",
      description: "把 README 的錯字改掉。\n\n細節略。",
      specPath: "docs/specs/readme fix.md",
    });
    w.domain.criteria.set(task.id, [
      { kind: "command", description: "pnpm lint", result: "passed" },
      { kind: "agent", description: "沒有其他錯字", result: "failed" },
    ]);
    await w.integration.onTaskChanged(task.id); // 建立對應的 Issue

    const result = await w.integration.onBranchPushed({
      taskId: task.id,
      runId: "run-1",
      branch: "feature/readme",
      commitSha: SHA,
    });

    expect(result).toMatchObject({ ok: true, created: true });
    const [call] = w.github.callsTo("createPullRequest");
    const input = call?.args[2] as { title: string; body: string; head: string; base: string };
    expect(input.title).toBe(`${task.key} ${task.title}`);
    expect(input.head).toBe("feature/readme");
    expect(input.base).toBe("main");
    expect(input.body.startsWith(PULL_REQUEST_MARKER)).toBe(true);
    expect(input.body).toContain(`Task：[${task.key}](https://pm.test/tasks/${task.key})`);
    expect(input.body).toContain("把 README 的錯字改掉。\n\n細節略。");
    expect(input.body).toContain(
      `[\`docs/specs/readme fix.md\`](${w.repo.htmlUrl}/blob/feature%2Freadme/docs/specs/readme%20fix.md)`,
    );
    expect(input.body).toContain("| pnpm lint | `command` | ✅ 通過 |");
    expect(input.body).toContain("| 沒有其他錯字 | `agent` | ❌ 失敗 |");
    expect(input.body).toContain("Closes #1");

    const link = await w.store.findPullRequestLink(w.repo.id, result.ok ? result.number : 0);
    expect(link).toMatchObject({ taskId: task.id, runId: "run-1", headSha: SHA, state: "open" });
  });

  it("很長的描述會截斷；沒有連結 Issue 時不加 Closes", async () => {
    const w = createWorld();
    const task = w.addTask({ description: "字".repeat(5000) });
    await w.integration.onBranchPushed({
      taskId: task.id,
      runId: "r",
      branch: "b",
      commitSha: SHA,
    });
    const { body } = createdPullRequest(w);
    expect(body).toContain(`${"字".repeat(1500)}…`);
    expect(body).not.toContain("字".repeat(1501));
    expect(body).not.toContain("Closes #");
  });

  it("同一個分支重複呼叫不會重開 PR", async () => {
    const w = createWorld();
    const { task } = await openedPr(w);
    const again = await w.integration.onBranchPushed({
      taskId: task.id,
      runId: "run-1",
      branch: `feature/${task.key}`,
      commitSha: SHA,
    });
    expect(again).toMatchObject({ ok: true, created: false });
    expect(w.github.callsTo("createPullRequest")).toHaveLength(1);
  });

  it("Repo 沒有 default branch 紀錄時向 GitHub 讀取並存回", async () => {
    const w = createWorld();
    const record = w.domain.repos.get(REPO_ID);
    if (record) record.defaultBranch = null;
    w.repo.defaultBranch = "trunk";
    const task = w.addTask();
    await w.integration.onBranchPushed({
      taskId: task.id,
      runId: "r",
      branch: "b",
      commitSha: SHA,
    });
    expect(createdPullRequest(w).base).toBe("trunk");
    expect(w.domain.repos.get(REPO_ID)?.defaultBranch).toBe("trunk");
  });

  it("GitHub 回錯時回傳失敗並通知負責人", async () => {
    const w = createWorld();
    const task = w.addTask({ assigneeMemberId: w.bob.id });
    w.github.failNext("createPullRequest");
    const result = await w.integration.onBranchPushed({
      taskId: task.id,
      runId: "r",
      branch: "b",
      commitSha: SHA,
    });
    expect(result).toMatchObject({ ok: false, reason: "github_error" });
    expect(w.notifier.sent).toMatchObject([
      { memberId: w.bob.id, kind: "pr_open_failed", taskId: task.id },
    ]);
  });

  it("Task 不存在、沒有 Repo、Repo 沒安裝 App 時回傳失敗", async () => {
    const w = createWorld();
    const push = { runId: "r", branch: "b", commitSha: SHA };
    expect(await w.integration.onBranchPushed({ ...push, taskId: "missing" })).toMatchObject({
      ok: false,
      reason: "task_not_found",
    });
    const noRepo = w.addTask({ repoId: null });
    expect(await w.integration.onBranchPushed({ ...push, taskId: noRepo.id })).toMatchObject({
      ok: false,
      reason: "no_repo",
    });
    await w.domain.updateRepoGitHubInfo(REPO_ID, { installationId: null });
    const task = w.addTask();
    expect(await w.integration.onBranchPushed({ ...push, taskId: task.id })).toMatchObject({
      ok: false,
      reason: "repo_not_connected",
    });
  });
});

describe("pull_request webhook", () => {
  it("closed 且 merged：Task 轉 Done、通知負責人、關閉對應的 Issue", async () => {
    const w = createWorld();
    const { task, number } = await openedPr(w);
    await w.integration.onTaskChanged(task.id); // 建立 Issue
    const response = await w.deliver(
      "pull_request",
      w.pullRequestPayload("closed", number, { merged: true, sender: w.userRef(w.bob) }),
    );

    expect(response.body).toMatchObject({ result: { kind: "merged", transitioned: true } });
    expect(w.domain.task(task.id).status).toBe("done");
    expect(w.domain.transitions).toMatchObject([
      { to: "done", cause: { kind: "pr_merged", doneReason: "completed" } },
    ]);
    expect(w.domain.task(task.id).doneReason).toBe("completed");
    expect(w.notifier.sent).toMatchObject([{ memberId: w.alice.id, kind: "pr_merged" }]);
    expect((await w.store.findPullRequestLink(w.repo.id, number))?.state).toBe("merged");
    const link = await w.store.getIssueLinkByTask(task.id);
    expect(w.github.issue(w.repo.id, link?.issueNumber ?? 0).state).toBe("closed");
  });

  it("closed 沒有 merge：退回 Review Gate 並通知負責人", async () => {
    const w = createWorld();
    const { task, number } = await openedPr(w);
    await w.deliver(
      "pull_request",
      w.pullRequestPayload("closed", number, { merged: false, sender: w.userRef(w.bob) }),
    );
    expect(w.domain.task(task.id).status).toBe("review_gate");
    expect(w.domain.transitions).toMatchObject([
      { to: "review_gate", cause: { kind: "pr_closed", byGithubLogin: "bob" } },
    ]);
    expect(w.notifier.sent).toMatchObject([
      { memberId: w.alice.id, kind: "pr_closed_unmerged", taskId: task.id },
    ]);
    expect(w.notifier.sent[0]?.message).toContain("@bob");
  });

  it("reopened：回到 PR Open", async () => {
    const w = createWorld();
    const { task, number } = await openedPr(w);
    const sender = w.userRef(w.bob);
    await w.deliver(
      "pull_request",
      w.pullRequestPayload("closed", number, { merged: false, sender }),
    );
    await w.deliver(
      "pull_request",
      w.pullRequestPayload("reopened", number, { merged: false, sender }),
    );
    expect(w.domain.task(task.id).status).toBe("pr_open");
    expect((await w.store.findPullRequestLink(w.repo.id, number))?.state).toBe("open");
  });

  it("沒有寫入權限的人（例如 triage）關閉 PR：Task 不轉換，記錄 PR 狀態並通知負責人", async () => {
    const w = createWorld();
    const { task, number } = await openedPr(w);
    w.github.roles.set(w.outsider.login, "triage");
    const response = await w.deliver(
      "pull_request",
      w.pullRequestPayload("closed", number, { merged: false, sender: w.outsider }),
    );
    expect(response.body).toMatchObject({
      result: { kind: "rejected", reason: "sender_not_authorized" },
    });
    expect(w.domain.transitions).toEqual([]);
    expect(w.domain.task(task.id).status).toBe("pr_open");
    expect((await w.store.findPullRequestLink(w.repo.id, number))?.state).toBe("closed");
    expect(w.notifier.sent).toMatchObject([{ memberId: w.alice.id, taskId: task.id }]);
    expect(w.notifier.sent[0]?.message).toContain(`@${w.outsider.login}`);
  });

  it("沒有寫入權限的人重開 PR：Task 不轉換", async () => {
    const w = createWorld();
    const { task, number } = await openedPr(w);
    await w.deliver(
      "pull_request",
      w.pullRequestPayload("closed", number, { merged: false, sender: w.userRef(w.bob) }),
    );
    await w.deliver(
      "pull_request",
      w.pullRequestPayload("reopened", number, { merged: false, sender: w.outsider }),
    );
    expect(w.domain.task(task.id).status).toBe("review_gate");
  });

  it("沒有負責人時通知建立者", async () => {
    const w = createWorld();
    const { number } = await openedPr(w, { assigneeMemberId: null, createdByMemberId: w.bob.id });
    await w.deliver(
      "pull_request",
      w.pullRequestPayload("closed", number, { merged: false, sender: w.userRef(w.alice) }),
    );
    expect(w.notifier.sent).toMatchObject([{ memberId: w.bob.id }]);
  });

  it("重複送達（不同 delivery ID）只轉換一次、只通知一次", async () => {
    const w = createWorld();
    const { number } = await openedPr(w);
    const payload = w.pullRequestPayload("closed", number, {
      merged: true,
      sender: w.userRef(w.bob),
    });
    await w.deliver("pull_request", payload);
    const again = await w.deliver("pull_request", payload);
    expect(again.body).toMatchObject({ result: { kind: "ignored", reason: "already_handled" } });
    expect(w.domain.transitions).toHaveLength(1);
    expect(w.notifier.sent).toHaveLength(1);
  });

  it("merge 之後的 closed／reopened 不再改變 Task", async () => {
    const w = createWorld();
    const { number } = await openedPr(w);
    const sender = w.userRef(w.bob);
    await w.deliver(
      "pull_request",
      w.pullRequestPayload("closed", number, { merged: true, sender }),
    );
    await w.deliver(
      "pull_request",
      w.pullRequestPayload("reopened", number, { merged: false, sender }),
    );
    expect(w.domain.transitions).toHaveLength(1);
  });

  it("不是以 App 開出的 PR、其他 action 一律忽略", async () => {
    const w = createWorld();
    for (const name of ["pull_request.closed", "pull_request.reopened", "pull_request.opened"]) {
      const response = await w.deliver("pull_request", fixture(name));
      expect(response.status, name).toBe(200);
    }
    const { number } = await openedPr(w);
    const opened = await w.deliver(
      "pull_request",
      w.pullRequestPayload("opened", number, { merged: false, sender: w.userRef(w.bob) }),
    );
    expect(opened.body).toMatchObject({ result: { kind: "ignored", reason: "unhandled_action" } });
    expect(w.domain.transitions).toEqual([]);
  });
});
