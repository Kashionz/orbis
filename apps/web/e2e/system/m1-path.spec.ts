// M1 路徑跑在完整系統上（完成條件）：真實 Server + Postgres + Local Runner + Fake Agent（m1.yaml）。
// 系統由 globalSetup 啟動（見 playwright.system.config.ts），種子資料是一個 Owner、一個 Project
// （預設 Permission Policy 是 manual）與指向本機 bare repo 的 Repo。

import { execFileSync } from "node:child_process";
import { API_ROUTES, apiPath, Run } from "@orbis/api-contract";
import { expect, type Page, test } from "@playwright/test";
import { readStack } from "./stack";

const stack = readStack();

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ ...stack.sessionCookie, url: baseURL ?? "" }]);
});

/** 用滑鼠把 Task 卡片拖到某一欄（dnd-kit 需要中間的移動事件）。 */
async function dragCard(page: Page, taskKey: string, status: string): Promise<void> {
  const from = await page.locator(`[data-task-key="${taskKey}"]`).boundingBox();
  const to = await page.locator(`.board-column[data-status="${status}"]`).boundingBox();
  if (!from || !to) throw new Error("找不到要拖曳的元素");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 15 });
  await page.mouse.up();
}

test("M1 路徑：建立 Task → 派工到我的電腦 → 即時 Event → 回覆權限請求 → diff 留言退回 → 第二回合 → 核准 → PR Open", async ({
  page,
}) => {
  // 建立 Task（描述與 Acceptance Criterion 是進入 Ready 的條件）
  await page.goto("/board");
  await page.getByRole("button", { name: "新增 Task" }).click();
  const create = page.getByRole("dialog", { name: "新增 Task" });
  await create.getByLabel("標題").fill("M1：新增 m1.txt");
  await create.getByLabel("描述（markdown）").fill("新增 `m1.txt`。");
  await create.getByRole("button", { name: "建立" }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${stack.projectKey}-\\d+$`));
  const taskKey = page.url().split("/").pop() ?? "";

  await page.getByRole("button", { name: "新增 Acceptance Criterion" }).click();
  await page.locator(".ac-form").getByLabel("類型").selectOption("manual");
  await page.locator(".ac-form").getByLabel("條件").fill("m1.txt 存在");
  await page.locator(".ac-form").getByRole("button", { name: "加入" }).click();
  await expect(page.locator(".ac-list > li")).toHaveCount(1);

  // 看板：Backlog → Ready，再拖到 Running 開派工對話框
  await page.goto("/board");
  await dragCard(page, taskKey, "ready");
  await expect(page.locator(`[data-status="ready"] [data-task-key="${taskKey}"]`)).toBeVisible();
  await dragCard(page, taskKey, "running");
  const dispatch = page.getByRole("dialog", { name: `派工 ${taskKey}` });
  await expect(dispatch.getByRole("radio", { name: "我的電腦" })).toBeChecked();
  await expect(dispatch.getByRole("radio", { name: /^claude-code/ })).toBeChecked();
  // Project 的預設政策是 manual
  await expect(dispatch.getByRole("radio", { name: /^manual/ })).toBeChecked();
  await dispatch.getByRole("button", { name: "派工" }).click();
  await expect(page).toHaveURL(/\/runs\/[^/?]+$/);
  const runId = page.url().split("/").pop() ?? "";

  // 即時 Event：Worktree 建好、Agent 請求寫檔權限，Needs You 也出現這筆請求
  const timeline = page.getByTestId("timeline");
  await expect(timeline).toContainText("Worktree 已就緒");
  await expect(timeline).toContainText("我要新增 m1.txt。");
  const request = timeline.locator('.event-permission[data-resolved="false"]');
  await expect(request).toContainText("新增 m1.txt");
  await expect(page.getByTestId("needs-you-count")).toBeVisible();
  await request.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(timeline.locator('.event-permission[data-resolved="true"]')).toHaveCount(1);
  await expect(timeline).toContainText("已新增 m1.txt。");

  // 第一回合結束，進入 Review Gate
  await expect(page.getByTestId("run-status")).toHaveText("等待 Gate");
  await expect(timeline).toContainText("已產生 review diff");
  await page.getByRole("link", { name: "Diff review" }).click();
  await page
    .locator(".file-list")
    .getByRole("button", { name: /m1\.txt/ })
    .click();
  await expect(page.locator(".editor.modified .view-lines")).toContainText("version 1");

  // 在 m1.txt 第 1 行留言並退回（M1 劇本要求 prompt 含「改成第二版」）
  await page.getByLabel("行號").fill("1");
  await page.getByLabel("留言內容").fill("請改成第二版");
  await page.getByRole("button", { name: "加入留言" }).click();
  await page.getByRole("button", { name: /退回並附上留言/ }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));

  // 同一個 session 繼續：第二回合結束後再次進入 Review Gate
  await expect(timeline).toContainText("已改成第二版。");
  await expect(page.getByTestId("run-status")).toHaveText("等待 Gate");
  await page.getByRole("link", { name: "Diff review" }).click();
  await page
    .locator(".file-list")
    .getByRole("button", { name: /m1\.txt/ })
    .click();
  await expect(page.locator(".editor.modified .view-lines")).toContainText("version 2");

  // 核准：Task 進入 PR Open，Runner 把分支 push 到本機 bare repo 後 Run 完成
  await page.getByRole("button", { name: "核准並開 PR" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
  await expect(page.getByTestId("run-status")).toHaveText("已完成", { timeout: 60_000 });

  const response = await page.request.get(apiPath(API_ROUTES.run, { runId }));
  const run = Run.parse(await response.json());
  expect(run.branch).not.toBeNull();
  const pushed = execFileSync("git", ["show", `${run.branch}:m1.txt`], {
    cwd: stack.bareRepoPath,
    encoding: "utf8",
  });
  expect(pushed).toBe("version 2\n");

  await page.getByRole("link", { name: new RegExp(taskKey) }).click();
  await expect(page.locator(".page-header .status-badge")).toHaveText("PR Open");
  await page.goto("/board");
  await expect(page.locator(`[data-status="pr_open"] [data-task-key="${taskKey}"]`)).toBeVisible();
});
