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

/** 用滑鼠把 Task 卡片拖到看板分欄檢視的某一欄（dnd-kit 需要中間的移動事件）。 */
async function dragCard(page: Page, taskKey: string, status: string): Promise<void> {
  const from = await page.locator(`[data-task-key="${taskKey}"]`).boundingBox();
  const to = await page.locator(`.bd-column[data-status="${status}"]`).boundingBox();
  if (!from || !to) throw new Error("找不到要拖曳的元素");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 5 });
  // 欄位可能有一部分在視窗外（左側有側欄）：目標點取欄位在視窗內的部分，視窗外的指標事件在 Windows 收不到
  const viewport = page.viewportSize();
  const x = Math.min(to.x + to.width / 2, (viewport?.width ?? to.x + to.width) - 10);
  await page.mouse.move(Math.max(to.x + 10, x), to.y + 60, { steps: 15 });
  await page.mouse.up();
}

/** 在差異分頁選檔案。 */
async function openFile(page: Page, name: RegExp): Promise<void> {
  await page.locator(".rp-file-tabs").getByRole("button", { name }).click();
}

test("M1 路徑：建立 Task → 派工到我的電腦 → 即時 Event → 回覆權限請求 → diff 留言退回 → 第二回合 → 核准 → PR Open", async ({
  page,
}) => {
  // 建立 Task（描述與 Acceptance Criterion 是進入 Ready 的條件）
  await page.goto("/board");
  await page
    .getByRole("button", { name: /^新增(任務| Task)$/ })
    .first()
    .click();
  const create = page.getByRole("dialog", { name: "新增任務" });
  await create.getByRole("textbox", { name: "任務標題" }).fill("M1：新增 m1.txt");
  await create.getByRole("textbox", { name: "描述要做什麼" }).fill("新增 `m1.txt`。");
  await create.getByRole("button", { name: /^建立並開啟/ }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${stack.projectKey}-[0-9]+$`));
  const taskKey = page.url().split("/").pop() ?? "";

  // 在任務分頁的內嵌編輯新增一條人工確認的條件
  await page.getByRole("tabpanel").getByRole("button", { name: "編輯", exact: true }).click();
  await page.getByRole("button", { name: "新增條件" }).click();
  const draft = page.locator(".rp-draft").last();
  await draft.getByLabel("條件描述").fill("m1.txt 存在");
  await draft.getByRole("button", { name: /條件類型/ }).click();
  await page.getByRole("menuitemradio", { name: /人工/ }).click();
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(page.locator(".rp-criterion")).toHaveCount(1);

  // 看板（分欄）：待辦 → 就緒，再拖到執行中開派工對話框
  await page.goto("/board");
  await page.getByRole("radio", { name: "分欄" }).click();
  await dragCard(page, taskKey, "ready");
  await expect(page.locator(`[data-status="ready"] [data-task-key="${taskKey}"]`)).toBeVisible();
  await dragCard(page, taskKey, "running");
  const dispatch = page.getByRole("dialog", { name: `派工 ${taskKey}` });
  await expect(dispatch.getByRole("radio", { name: /^我的電腦/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(dispatch.getByRole("radio", { name: /claude-code/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // Project 的預設政策是 manual
  await expect(dispatch.getByRole("radio", { name: "逐一確認" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await dispatch.getByRole("button", { name: "派工" }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskKey}[?]run=[^&]+$`));
  const runId = new URL(page.url()).searchParams.get("run") ?? "";

  // 即時 Event：工作樹建好、Agent 請求寫檔權限，待我處理也出現這筆請求
  const timeline = page.getByTestId("timeline");
  await expect(timeline).toContainText("工作樹已就緒");
  await expect(timeline).toContainText("我要新增 m1.txt。");
  const request = timeline.locator('.st-perm[data-resolved="false"]');
  await expect(request).toContainText("新增 m1.txt");
  await expect(page.getByTestId("needs-you-count")).toBeVisible();
  await request.getByRole("button", { name: "允許一次", exact: true }).click();
  await expect(timeline.locator('.st-perm[data-resolved="true"]')).toHaveCount(1);
  await expect(timeline).toContainText("已新增 m1.txt。");

  // 第一回合結束，進入審查關卡
  await expect(page.getByTestId("run-status")).toHaveText("等待審查關卡");
  await expect(timeline).toContainText("已產生審查差異");
  await page.getByRole("tab", { name: /差異/ }).click();
  await openFile(page, /m1\.txt/);
  await expect(page.locator(".rp-file")).toContainText("version 1");

  // 在 m1.txt 第 1 行留言並退回（M1 劇本要求 prompt 含「改成第二版」）
  await page.getByRole("button", { name: "對修改後第 1 行留言", exact: true }).click();
  await page.getByRole("combobox", { name: "對修改後第 1 行留言" }).fill("請改成第二版");
  await page.getByRole("button", { name: "加入留言" }).click();
  await page.getByRole("button", { name: "退回（1）" }).click();

  // 同一個 session 繼續：第二回合結束後再次進入審查關卡
  await expect(timeline).toContainText("已改成第二版。");
  await expect(page.getByTestId("run-status")).toHaveText("等待審查關卡");
  await openFile(page, /m1\.txt/);
  await expect(page.locator(".rp-file")).toContainText("version 2");

  // 人工確認的條件全部打勾後才能核准
  const approve = page.getByRole("button", { name: "核准並開啟合併請求" });
  await expect(approve).toBeDisabled();
  await page.getByRole("checkbox", { name: "m1.txt 存在" }).check();
  // 核准：Task 進入 PR Open，Runner 把分支 push 到本機 bare repo 後 Run 完成
  await approve.click();
  await expect(page.getByTestId("run-status")).toHaveText("已完成", { timeout: 60_000 });

  const response = await page.request.get(apiPath(API_ROUTES.run, { runId }));
  const run = Run.parse(await response.json());
  expect(run.branch).not.toBeNull();
  const pushed = execFileSync("git", ["show", `${run.branch}:m1.txt`], {
    cwd: stack.bareRepoPath,
    encoding: "utf8",
  });
  expect(pushed).toBe("version 2\n");

  await page.getByRole("tab", { name: /任務/ }).click();
  await expect(page.locator(".rp-status")).toHaveText("合併請求已開啟");
  await page.goto("/board");
  await expect(page.locator(`[data-status="pr_open"] [data-task-key="${taskKey}"]`)).toBeVisible();
});
