// GitHub→Orbis：`issues` webhook。payload 以錄製的真實 payload 為底，換上 FakeGitHub 中 Issue 的實際欄位。

import { describe, expect, it } from "vitest";
import type { IssuePatch } from "../src/client/types";
import { createWorld, fixture, type World } from "./helpers/world";

/** 建立一個已同步到 GitHub 的 Task。 */
async function syncedTask(w: World, overrides = {}) {
  const task = w.addTask(overrides);
  const outcome = await w.integration.onTaskChanged(task.id);
  if (outcome.kind !== "synced") throw new Error("同步失敗");
  w.github.calls.length = 0;
  return { task, issueNumber: outcome.issueNumber };
}

/** 有人在 GitHub 上改 Issue，並送出對應的 webhook。 */
async function humanChange(
  w: World,
  issueNumber: number,
  action: string,
  patch: IssuePatch,
  sender = w.userRef(w.bob),
  deliveryId?: string,
) {
  const issue = w.github.humanEdit(w.repo.id, issueNumber, patch);
  const payload = w.issuePayload(action, issue, sender);
  return {
    payload,
    response: await w.deliver("issues", payload, deliveryId ? { deliveryId } : {}),
  };
}

describe("issues webhook：欄位同步", () => {
  it("edited：title 與 body 寫回 Task（CRLF 換成 LF）", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w);

    const { response } = await humanChange(w, issueNumber, "edited", {
      title: "在 GitHub 改的標題",
      body: "第一行\r\n第二行",
    });

    expect(response.status).toBe(200);
    expect(w.domain.fieldUpdates).toEqual([
      { taskId: task.id, patch: { title: "在 GitHub 改的標題", description: "第一行\n第二行" } },
    ]);
    // 寫回 Task 之後不會再把同樣的值寫回 GitHub
    expect(w.github.callsTo("updateIssue")).toHaveLength(0);
  });

  it("assigned：第一個屬於 Team 的 assignee 成為負責人", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w);
    await humanChange(w, issueNumber, "assigned", { assignees: ["outsider", "bob"] });
    expect(w.domain.task(task.id).assigneeMemberId).toBe(w.bob.id);
  });

  it("unassigned：沒有 Team 成員時負責人設為 null", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w, { assigneeMemberId: "member-alice" });
    await humanChange(w, issueNumber, "unassigned", { assignees: ["outsider"] });
    expect(w.domain.task(task.id).assigneeMemberId).toBeNull();
  });

  it("labeled／unlabeled：labels 寫回 Task", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w, { labels: ["bug"] });
    await humanChange(w, issueNumber, "labeled", { labels: ["bug", "p1"] });
    expect(w.domain.task(task.id).labels).toEqual(["bug", "p1"]);
    await humanChange(w, issueNumber, "unlabeled", { labels: ["p1"] });
    expect(w.domain.task(task.id).labels).toEqual(["p1"]);
  });

  it("沒有對應 Task 的 Issue（例如新開的 Issue）不會建立 Task", async () => {
    const w = createWorld();
    const issue = w.github.humanOpenIssue(w.repo.id, { title: "別人開的 Issue" });
    const response = await w.deliver("issues", w.issuePayload("opened", issue, w.userRef(w.bob)));
    expect(response.status).toBe(200);
    expect(w.domain.createdFromIssue).toEqual([]);
    expect(w.domain.fieldUpdates).toEqual([]);
  });

  it("deleted／transferred：解除對應，Task 保留", async () => {
    for (const action of ["deleted", "transferred"]) {
      const w = createWorld();
      const { task, issueNumber } = await syncedTask(w);
      const issue = w.github.issue(w.repo.id, issueNumber);
      await w.deliver("issues", w.issuePayload(action, issue, w.userRef(w.bob)));
      expect(await w.store.getIssueLinkByTask(task.id)).toBeNull();
      expect(w.domain.tasks.has(task.id)).toBe(true);
    }
  });

  it("錄製的 payload 原樣送進來（沒有對應的 Issue）也能解析並忽略", async () => {
    const w = createWorld();
    for (const action of ["edited", "assigned", "unassigned", "labeled", "unlabeled", "opened"]) {
      const response = await w.deliver("issues", fixture(`issues.${action}`));
      expect(response, action).toMatchObject({ status: 200 });
    }
    expect(w.domain.fieldUpdates).toEqual([]);
  });
});

describe("issues webhook：state", () => {
  it("closed：Task 轉 Done", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w, { status: "ready" });
    await humanChange(w, issueNumber, "closed", { state: "closed" });
    expect(w.domain.task(task.id).status).toBe("done");
    expect(w.domain.transitions).toMatchObject([
      {
        taskId: task.id,
        from: "ready",
        to: "done",
        cause: { kind: "issue_closed", byGithubLogin: "bob" },
      },
    ]);
  });

  it("closed：Task 有進行中的 Run 時拒絕，Issue 重新打開並在摘要留言說明", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w, { status: "running" });
    w.domain.activeRunTaskIds.add(task.id);

    await humanChange(w, issueNumber, "closed", { state: "closed" });

    expect(w.domain.task(task.id).status).toBe("running");
    expect(w.github.issue(w.repo.id, issueNumber).state).toBe("open");
    const [summary] = w.github.commentsOn(w.repo.id, issueNumber);
    expect(summary?.body).toContain("@bob 關閉了這個 Issue，但 Task 還有進行中的 Run");
  });

  it("reopened：Done 的 Task 回到 Backlog", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w, { status: "done" });
    await humanChange(w, issueNumber, "reopened", { state: "open" });
    expect(w.domain.task(task.id).status).toBe("backlog");
  });

  it("reopened：狀態機拒絕時再次關閉 Issue", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w, { status: "done" });
    w.domain.forbiddenTransitions.add("done->backlog");
    await humanChange(w, issueNumber, "reopened", { state: "open" });
    expect(w.domain.task(task.id).status).toBe("done");
    expect(w.github.issue(w.repo.id, issueNumber).state).toBe("closed");
  });

  it("closed（not planned）：Task 轉 Done 並記錄關閉原因", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w, { status: "ready" });
    await humanChange(w, issueNumber, "closed", { state: "closed", stateReason: "not_planned" });
    expect(w.domain.task(task.id)).toMatchObject({ status: "done", doneReason: "not_planned" });
    expect(w.domain.transitions).toMatchObject([
      { to: "done", cause: { kind: "issue_closed", doneReason: "not_planned" } },
    ]);
    // 回寫時不會把關閉原因改回 completed
    expect(w.github.callsTo("updateIssue")).toHaveLength(0);
  });

  it("closed（duplicate）：視為 not_planned", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w, { status: "backlog" });
    await humanChange(w, issueNumber, "closed", { state: "closed", stateReason: "duplicate" });
    expect(w.domain.task(task.id)).toMatchObject({ status: "done", doneReason: "not_planned" });
  });

  it("closed：Done 的 Task 只改關閉原因，不再轉換", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w, { status: "done", doneReason: "completed" });
    await humanChange(w, issueNumber, "closed", { state: "closed", stateReason: "not_planned" });
    expect(w.domain.transitions).toEqual([]);
    expect(w.domain.fieldUpdates).toEqual([
      { taskId: task.id, patch: { doneReason: "not_planned" } },
    ]);
    expect(w.domain.task(task.id).doneReason).toBe("not_planned");
  });

  it("reopened：清空關閉原因", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w, {
      status: "done",
      doneReason: "not_planned",
    });
    await humanChange(w, issueNumber, "reopened", { state: "open" });
    expect(w.domain.task(task.id)).toMatchObject({ status: "backlog", doneReason: null });
  });

  it("closed：已經是 Done 的 Task 不再轉換", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w, { status: "done" });
    // 先在 GitHub 重新打開但被拒絕，再關閉
    w.domain.forbiddenTransitions.add("done->backlog");
    await humanChange(w, issueNumber, "reopened", { state: "open" });
    w.domain.transitions.length = 0;
    await humanChange(w, issueNumber, "closed", { state: "closed" });
    expect(w.domain.transitions).toEqual([]);
    expect(w.domain.task(task.id).status).toBe("done");
  });
});

describe("同步的回音", () => {
  it("App 自己寫出的變更造成的 webhook 不會寫回 Task", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w);

    // Task 端修改 → 寫到 GitHub → GitHub 送回 sender 是 App bot 的 webhook
    w.domain.editTask(task.id, { title: "Task 端改的標題", labels: ["p2"], status: "done" });
    await w.integration.onTaskChanged(task.id);
    const issue = w.github.issue(w.repo.id, issueNumber);
    for (const action of ["edited", "labeled", "closed"]) {
      const response = await w.deliver("issues", w.issuePayload(action, issue, w.bot));
      expect(response.body).toMatchObject({ ok: true, result: [{ kind: "echo" }] });
    }

    expect(w.domain.fieldUpdates).toEqual([]);
    expect(w.domain.transitions).toEqual([]);
  });

  it("就算 sender 不是 App（例如 bot 名稱設定錯），payload 與快照相同也不會寫入", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w);
    w.domain.editTask(task.id, { title: "Task 端改的標題" });
    await w.integration.onTaskChanged(task.id);
    const issue = w.github.issue(w.repo.id, issueNumber);

    const response = await w.deliver("issues", w.issuePayload("edited", issue, w.userRef(w.bob)));

    expect(response.body).toMatchObject({ result: [{ kind: "no_change" }] });
    expect(w.domain.fieldUpdates).toEqual([]);
    expect(w.github.callsTo("updateIssue")).toHaveLength(1);
  });

  it("比 App 的寫入還舊的 payload（晚到的 webhook）不會蓋掉 Task 的值", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w);

    // 1. 有人在 GitHub 改了 title（webhook 晚到）
    const stale = w.github.humanEdit(w.repo.id, issueNumber, { title: "GitHub 舊的修改" });
    const stalePayload = w.issuePayload("edited", stale, w.userRef(w.bob));
    // 2. 之後 Orbis 改了 title 並寫出
    w.domain.editTask(task.id, { title: "Task 端較新的修改" });
    await w.integration.onTaskChanged(task.id);
    // 3. 晚到的 webhook
    await w.deliver("issues", stalePayload);

    expect(w.domain.task(task.id).title).toBe("Task 端較新的修改");
    expect(w.github.issue(w.repo.id, issueNumber).title).toBe("Task 端較新的修改");
    expect(w.domain.fieldUpdates).toEqual([]);
  });
});

describe("重複的 delivery", () => {
  it("同一個 delivery 送兩次只寫入一次", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w);
    const { payload } = await humanChange(
      w,
      issueNumber,
      "edited",
      { title: "改一次" },
      undefined,
      "dup-1",
    );

    const again = await w.deliver("issues", payload, { deliveryId: "dup-1" });

    expect(again).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(w.domain.fieldUpdates).toEqual([{ taskId: task.id, patch: { title: "改一次" } }]);
  });

  it("不同 delivery 但內容相同（例如 GitHub 送了兩種 action）也只寫入一次", async () => {
    const w = createWorld();
    const { issueNumber } = await syncedTask(w);
    const { payload } = await humanChange(w, issueNumber, "labeled", { labels: ["a", "b"] });
    await w.deliver("issues", payload);
    expect(w.domain.fieldUpdates).toHaveLength(1);
  });

  it("closed 重複送達只轉換一次", async () => {
    const w = createWorld();
    const { issueNumber } = await syncedTask(w, { status: "ready" });
    const { payload } = await humanChange(w, issueNumber, "closed", { state: "closed" });
    await w.deliver("issues", payload);
    expect(w.domain.transitions).toHaveLength(1);
  });
});

describe("衝突：最後寫入者為準", () => {
  it("同一欄位兩邊都改過，GitHub 比較新 → 套用 GitHub 的值", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w);
    // Orbis 改了 title，但還沒同步出去（例如上次同步失敗）
    w.domain.editTask(task.id, { title: "Task 端的修改" });
    // 之後有人在 GitHub 也改了 title
    await humanChange(w, issueNumber, "edited", { title: "GitHub 的修改" });

    expect(w.domain.task(task.id).title).toBe("GitHub 的修改");
    expect(w.github.issue(w.repo.id, issueNumber).title).toBe("GitHub 的修改");
  });

  it("同一欄位兩邊都改過，Task 比較新 → 保留 Task 的值並寫回 GitHub", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w);
    // 有人在 GitHub 改了 title，webhook 還沒到
    const issue = w.github.humanEdit(w.repo.id, issueNumber, { title: "GitHub 的修改" });
    const payload = w.issuePayload("edited", issue, w.userRef(w.bob));
    // Orbis 之後也改了 title，但同步還沒跑
    w.domain.editTask(task.id, { title: "Task 端的修改" });

    const response = await w.deliver("issues", payload);

    expect(response.body).toMatchObject({
      result: [{ kind: "applied", applied: [], overridden: ["title"] }],
    });
    expect(w.domain.task(task.id).title).toBe("Task 端的修改");
    expect(w.github.issue(w.repo.id, issueNumber).title).toBe("Task 端的修改");
    expect(w.domain.fieldUpdates).toEqual([]);
  });

  it("兩邊改不同欄位時兩邊的修改都保留", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w);
    w.domain.editTask(task.id, { description: "Task 端改的描述" });
    await humanChange(w, issueNumber, "labeled", { labels: ["from-github"] });

    expect(w.domain.task(task.id)).toMatchObject({
      description: "Task 端改的描述",
      labels: ["from-github"],
    });
    expect(w.github.issue(w.repo.id, issueNumber)).toMatchObject({
      body: "Task 端改的描述",
      labels: ["from-github"],
    });
  });
});

describe("issue_comment webhook", () => {
  it("摘要留言被刪除時立即重建", async () => {
    const w = createWorld();
    const { issueNumber } = await syncedTask(w);
    const [comment] = w.github.commentsOn(w.repo.id, issueNumber);
    w.github.humanDeleteComment(w.repo.id, comment?.id ?? 0);

    const payload = fixture("issue_comment.deleted");
    payload.comment.id = comment?.id;
    payload.issue.number = issueNumber;
    payload.repository.id = w.repo.id;
    await w.deliver("issue_comment", payload);

    const comments = w.github.commentsOn(w.repo.id, issueNumber);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).not.toBe(comment?.id);
  });

  it("刪除的不是摘要留言時不處理", async () => {
    const w = createWorld();
    const { issueNumber } = await syncedTask(w);
    const payload = fixture("issue_comment.deleted");
    payload.issue.number = issueNumber;
    payload.repository.id = w.repo.id;
    const response = await w.deliver("issue_comment", payload);
    expect(response.body).toMatchObject({ result: { recreated: [] } });
    expect(w.github.calls).toEqual([]);
  });
});

describe("修改者的權限", () => {
  it("沒有寫入權限的人（例如公開 repo 上 Issue 的作者）關閉 Issue：Task 不變，Issue 重新打開並說明", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w, { status: "ready" });

    const { response } = await humanChange(
      w,
      issueNumber,
      "closed",
      { state: "closed" },
      w.outsider,
    );

    expect(response.body).toMatchObject({
      result: [{ kind: "rejected", fields: ["state"], reason: "sender_not_authorized" }],
    });
    expect(w.domain.transitions).toEqual([]);
    expect(w.domain.task(task.id).status).toBe("ready");
    expect(w.github.issue(w.repo.id, issueNumber).state).toBe("open");
    const [summary] = w.github.commentsOn(w.repo.id, issueNumber);
    expect(summary?.body).toContain("@outsider 沒有這個 repo 的寫入權限");
    expect(
      w.github.callsTo("getCollaboratorRole").map((c) => (c.args[2] as { login: string }).login),
    ).toEqual(["outsider"]);
  });

  it("沒有寫入權限的人改 title：不寫回 Task，Issue 改回 Task 的值", async () => {
    const w = createWorld();
    w.github.roles.set("outsider", "triage");
    const { task, issueNumber } = await syncedTask(w);
    await humanChange(w, issueNumber, "edited", { title: "亂改的標題" }, w.outsider);
    expect(w.domain.fieldUpdates).toEqual([]);
    expect(w.github.issue(w.repo.id, issueNumber).title).toBe(task.title);
  });

  it("不是 Team 成員、但對 repo 有寫入權限的人的修改會套用", async () => {
    const w = createWorld();
    w.github.roles.set("outsider", "write");
    const { task, issueNumber } = await syncedTask(w);
    await humanChange(w, issueNumber, "edited", { title: "協作者改的標題" }, w.outsider);
    expect(w.domain.task(task.id).title).toBe("協作者改的標題");
  });

  it("Team 成員不需要查詢 repo 權限", async () => {
    const w = createWorld();
    const { issueNumber } = await syncedTask(w);
    await humanChange(w, issueNumber, "edited", { title: "成員改的" }, w.userRef(w.bob));
    expect(w.github.callsTo("getCollaboratorRole")).toEqual([]);
  });
});

describe("Issue 對應的 repo 與 Task 的 Repo 不同", () => {
  it("不寫到另一個 repo 的 Issue，改為在 Task 的 Repo 重新建立", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w);
    const link = await w.store.getIssueLinkByTask(task.id);
    if (!link) throw new Error("沒有對應");
    await w.store.saveIssueLink({ ...link, githubRepoId: 424242 });

    w.domain.editTask(task.id, { title: "改了標題" });
    const outcome = await w.integration.onTaskChanged(task.id);

    expect(outcome).toMatchObject({ kind: "synced", created: true });
    expect(w.github.callsTo("updateIssue")).toEqual([]);
    expect(w.github.issue(w.repo.id, issueNumber).title).toBe(task.title);
    expect((await w.store.getIssueLinkByTask(task.id))?.githubRepoId).toBe(w.repo.id);
  });
});

describe("只套用這個 action 改到的欄位", () => {
  it("edited 的 changes 只有 body 時，與快照不同的 title 不套用", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w);
    // 沒寫入權限的人改了 title（這則 webhook 遺失），之後 Member 改了 body
    w.github.humanEdit(w.repo.id, issueNumber, { title: "外人改的標題" });
    const issue = w.github.humanEdit(w.repo.id, issueNumber, { body: "Member 改的內容" });
    const payload = w.issuePayload("edited", issue, w.userRef(w.bob), { changes: ["body"] });

    await w.deliver("issues", payload);

    expect(w.domain.fieldUpdates).toEqual([
      { taskId: task.id, patch: { description: "Member 改的內容" } },
    ]);
    expect(w.domain.task(task.id).title).toBe(task.title);
  });

  it("labeled 不會順便套用 payload 中被改過的 title", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w);
    w.github.humanEdit(w.repo.id, issueNumber, { title: "沒有對應 webhook 的修改" });
    const issue = w.github.humanEdit(w.repo.id, issueNumber, { labels: ["p1"] });
    await w.deliver("issues", w.issuePayload("labeled", issue, w.userRef(w.bob)));
    expect(w.domain.task(task.id)).toMatchObject({ title: task.title, labels: ["p1"] });
  });

  it("晚到的 edited webhook 仍然會套用（先到的 labeled 沒有動 title 的快照）", async () => {
    const w = createWorld();
    const { task, issueNumber } = await syncedTask(w);
    const edited = w.github.humanEdit(w.repo.id, issueNumber, { title: "先改的標題" });
    const editedPayload = w.issuePayload("edited", edited, w.userRef(w.bob), {
      changes: ["title"],
    });
    const labeled = w.github.humanEdit(w.repo.id, issueNumber, { labels: ["p1"] });
    await w.deliver("issues", w.issuePayload("labeled", labeled, w.userRef(w.bob)));
    await w.deliver("issues", editedPayload);
    expect(w.domain.task(task.id)).toMatchObject({ title: "先改的標題", labels: ["p1"] });
  });
});

describe("Viewer 的修改", () => {
  it("不能編輯 Task 的 Member（例如 Viewer），而且沒有 repo 寫入權限：修改還原", async () => {
    const w = createWorld();
    w.domain.viewerMemberIds.add(w.bob.id);
    w.github.roles.delete(w.bob.githubLogin);
    const { task, issueNumber } = await syncedTask(w);
    await humanChange(w, issueNumber, "edited", { title: "Viewer 改的" }, w.userRef(w.bob));
    expect(w.domain.fieldUpdates).toEqual([]);
    expect(w.github.issue(w.repo.id, issueNumber).title).toBe(task.title);
  });
});
