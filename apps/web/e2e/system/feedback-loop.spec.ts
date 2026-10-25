// Feedback Loop 跑在完整系統上（M2 的完成條件，ARCHITECTURE §5.2）：PR 開出後，review 留言與 CI 失敗
// 各觸發一次修正 Run（origin = feedback_loop），派回同一台 Runner、沿用同一個 Worktree 與分支，
// 以 session/load 接回同一個 ACP session，修正後直接 push，Task 回到 PR Open。
//
// - webhook 以 D 軌錄製的 fixture 為底（`@orbis/server/e2e` 的 helper），review 的 sender 是種子資料的 Member。
// - CI 路徑：Server 收到 check webhook 後向 FakeGitHub 查這個 commit 的 check suite 與 check run，
//   FakeGitHub 在 stack 的程序中，所以先以 stack 的 stdin 指令 `seed_checks` 餵進去。
// Fake Agent 用 feedback.yaml。這個檔案自己啟動一組 stack 與 Vite（全域的那組用 m1.yaml）。

import { execFileSync } from "node:child_process";
import { API_ROUTES, apiPath, Run, Task, TaskNoteListResponse } from "@orbis/api-contract";
import {
  findPullRequest,
  sendCheckFailedWebhooks,
  sendPullRequestReviewWebhook,
} from "@orbis/server/e2e";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { freePort, type StartedStack, type StartedWeb, startStack, startWeb } from "./stack";

let stack: StartedStack;
let web: StartedWeb;
let baseURL: string;

/** 分支上 fl.txt 的內容（Runner push 到本機 bare repo 的結果）。 */
function pushedFile(branch: string): string {
  return execFileSync("git", ["show", `${branch}:fl.txt`], {
    cwd: stack.ready.bareRepoPath,
    encoding: "utf8",
  });
}

async function runsOf(request: APIRequestContext, taskId: string): Promise<Run[]> {
  const res = await request.get(apiPath(API_ROUTES.taskRuns, { taskId }));
  return z.array(Run).parse(await res.json());
}

/** 等 Task 出現第 n 個 Feedback Loop 的 Run，而且已經完成（push 成功後 Run 才算 completed）。 */
async function untilFeedbackRunCompleted(
  request: APIRequestContext,
  taskId: string,
  count: number,
): Promise<Run> {
  let latest: Run | undefined;
  await expect
    .poll(
      async () => {
        const feedback = (await runsOf(request, taskId))
          .filter((r) => r.origin === "feedback_loop")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        latest = feedback[count - 1];
        return feedback.length >= count ? latest?.status : `只有 ${feedback.length} 個修正 Run`;
      },
      { timeout: 180_000, message: `第 ${count} 個 Feedback Loop 的 Run 完成` },
    )
    .toBe("completed");
  if (!latest) throw new Error("沒有 Feedback Loop 的 Run");
  return latest;
}

test.describe("Feedback Loop（完整系統）", () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000);
    const serverPort = await freePort();
    const webPort = await freePort();
    baseURL = `http://localhost:${webPort}`;
    stack = await startStack(serverPort, baseURL, {
      agentScript: "feedback.yaml",
      logPrefix: "feedback-loop-",
    });
    web = await startWeb(webPort, serverPort, "feedback-loop-");
  });

  test.afterAll(async () => {
    await web?.stop();
    await stack?.stop();
  });

  test("PR Open 後：review 留言觸發修正並 push；CI 失敗觸發第二次修正；Task 頁顯示 Feedback Loop 的 Run 與 Task note", async ({
    browser,
  }) => {
    const ready = stack.ready;
    const context = await browser.newContext({ baseURL });
    await context.addCookies([{ ...ready.sessionCookie, url: baseURL }]);
    const page: Page = await context.newPage();
    const request = context.request;
    const headers = { origin: baseURL };

    // ---- 原本的 Run 走到 PR Open：建立 Task → 派工 → Review Gate 核准 → push → 開 PR
    const created = await request.post(
      apiPath(API_ROUTES.projectTasks, { projectId: ready.projectId }),
      {
        headers,
        data: {
          repoId: ready.repoId,
          title: "Feedback Loop：fl.txt",
          description: "新增 fl.txt。",
        },
      },
    );
    const task = Task.parse(await created.json());
    await request.post(apiPath(API_ROUTES.taskAcceptanceCriteria, { taskId: task.id }), {
      headers,
      data: { kind: "manual", description: "fl.txt 存在" },
    });
    await request.post(apiPath(API_ROUTES.taskTransition, { taskId: task.id }), {
      headers,
      data: { status: "ready" },
    });
    const dispatched = await request.post(apiPath(API_ROUTES.taskRuns, { taskId: task.id }), {
      headers,
      data: { agent: "claude-code", runnerKind: "local", permissionPolicy: "manual" },
    });
    const original = Run.parse(await dispatched.json());

    await page.goto(`/runs/${original.id}`);
    await expect(page.getByTestId("run-status")).toHaveText("等待審查關卡", { timeout: 120_000 });
    await page.getByRole("button", { name: "開啟差異審查" }).click();
    await page.getByRole("checkbox", { name: "fl.txt 存在" }).check();
    await page.getByRole("button", { name: "核准並開啟合併請求" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("已完成", { timeout: 60_000 });
    const branch = original.branch ?? (await runsOf(request, task.id))[0]?.branch ?? "";
    expect(branch).not.toBe("");
    expect(pushedFile(branch)).toBe("v1\n");
    await page.goto(`/tasks/${task.key}`);
    await expect(page.locator(".rp-status")).toHaveText("合併請求已開啟");
    const opened = await findPullRequest(ready, { branch });

    // ---- review 留言：有寫入權限的人類（種子 Member）送出有內容的 review，立刻觸發修正
    const review = await sendPullRequestReviewWebhook(
      ready,
      { branch },
      {
        body: "請把 v1 改成 v2",
      },
    );
    expect(review.status).toBe(200);
    // Task PR Open → Running（修正中）→ 修正 push 後回到 PR Open
    const firstFix = await untilFeedbackRunCompleted(request, task.id, 1);
    expect(firstFix.resumesRunId).toBe(original.id);
    expect(firstFix.branch).toBe(branch);
    expect(pushedFile(branch)).toBe("v2\n");
    await expect(page.locator(".rp-status")).toHaveText("合併請求已開啟", { timeout: 30_000 });
    // 任務分頁的執行紀錄：第二個 Run 標示回饋循環、已完成
    const tree = page.getByRole("list", { name: "執行紀錄" });
    await expect(tree.locator(".rp-run")).toHaveCount(2);
    const fixNode = tree.locator(`.rp-run[data-run-id="${firstFix.id}"]`);
    await expect(fixNode).toContainText("回饋循環");
    await expect(fixNode).toContainText("已完成");
    // 修正 Run 的事件串流：接回同一個 session，收到 review 留言的 prompt
    await page.goto(`/runs/${firstFix.id}`);
    await expect(page.getByTestId("timeline")).toContainText("已依 review 留言改成 v2。");
    await expect(page.getByTestId("run-origin")).toContainText("回饋循環");

    // ---- CI 失敗：PR 的 head 已經是修正後的 commit；先餵 FakeGitHub 這個 commit 的 check，再送 webhook
    const synchronized = await findPullRequest(ready, { branch });
    expect(synchronized.number).toBe(opened.number);
    expect(synchronized.headSha).not.toBe(opened.headSha);
    await stack.commander.send({
      command: "seed_checks",
      sha: synchronized.headSha,
      runs: [
        { id: 501, name: "lint", conclusion: "success" },
        { id: 502, name: "e2e-ci-test", conclusion: "failure" },
      ],
    });
    const ci = await sendCheckFailedWebhooks(
      ready,
      { branch },
      [{ id: 502, name: "e2e-ci-test" }],
      {
        totalCheckRuns: 2,
      },
    );
    expect(ci.statuses.every((status) => status === 200)).toBe(true);
    const secondFix = await untilFeedbackRunCompleted(request, task.id, 2);
    expect(secondFix.resumesRunId).toBe(firstFix.id);
    expect(pushedFile(branch)).toBe("v3\n");
    await page.goto(`/runs/${secondFix.id}`);
    await expect(page.getByTestId("timeline")).toContainText("已依 CI 失敗改成 v3。");

    // ---- 紀錄：每次修正在 Task（Task note）與 PR 上留下紀錄，註明來源
    const notes = TaskNoteListResponse.parse(
      await (await request.get(apiPath(API_ROUTES.taskNotes, { taskId: task.id }))).json(),
    );
    expect(notes.filter((n) => n.runId === firstFix.id)).not.toHaveLength(0);
    expect(notes.filter((n) => n.runId === secondFix.id)).not.toHaveLength(0);
    const comments = await stack.commander.send<{ body: string }[]>({
      command: "list_issue_comments",
      number: opened.number,
    });
    // 紀錄留言列出觸發的 review（作者）與失敗的 check 名稱，各是第 1 次（review 與 CI 分開計數）
    const records = comments.filter((c) => c.body.includes("自動修正"));
    expect(records.some((c) => c.body.includes("的 [review](") && c.body.includes("第 1／"))).toBe(
      true,
    );
    expect(records.some((c) => c.body.includes("`e2e-ci-test`") && c.body.includes("第 1／"))).toBe(
      true,
    );

    await page.goto(`/tasks/${task.key}`);
    await expect(page.locator(".rp-status")).toHaveText("合併請求已開啟");
    await expect(page.getByRole("list", { name: "執行紀錄" }).locator(".rp-run")).toHaveCount(3);
    await context.close();
  });
});
