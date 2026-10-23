// M1 路徑跑在完整系統上（完成條件）：真實 Server + Postgres + Local Runner + Fake Agent。
//
// 前提（由整合流程準備，見 PR 說明的「整合需求」）：
// - `<前綴>SYSTEM_E2E_BASE_URL`：Web 的網址（Vite 已 proxy 到 Server）。
// - `<前綴>SYSTEM_E2E_SESSION`：測試 Member 的 session cookie 值（Role 為 Owner）。
// - Server 中已有一個 Project（含一個 Repo），測試 Member 的 Local Runner 已完成 Pairing 並在線，
//   而且它的 Agent 以 Fake Agent 執行 M1 劇本：第一回合先請求寫檔權限再產生 diff，
//   退回後的第二回合依留言修改。
//
// B1 的 `e2e:stack`（啟動 Postgres、Server、Runner 並建立種子資料）合併後，改由 Playwright 啟動
// 完整系統並讀取它印出的 session cookie；在那之前以上面兩個環境變數提供。

import { envVar, NAMES } from "@orbis/api-contract/names";
import { expect, test } from "@playwright/test";

const baseURL = process.env[envVar("SYSTEM_E2E_BASE_URL")];
const session = process.env[envVar("SYSTEM_E2E_SESSION")];

test.skip(!baseURL || !session, "沒有設定完整系統的網址與 session，略過");

test.beforeEach(async ({ context }) => {
  if (!baseURL || !session) return;
  await context.addCookies([
    { name: `${NAMES.productSlug}_session`, value: session, url: baseURL },
  ]);
});

test("M1 路徑：建立 Task → 派工 → 即時 Event → 回覆權限請求 → diff 留言退回 → 核准", async ({
  page,
}) => {
  const title = `M1 系統測試 ${Date.now()}`;

  // 建立 Task（含描述與 Acceptance Criterion，才能進入 Ready）
  await page.goto("/board");
  await page.getByRole("button", { name: "新增 Task" }).click();
  const create = page.getByRole("dialog", { name: "新增 Task" });
  await create.getByLabel("標題").fill(title);
  await create.getByLabel("描述（markdown）").fill("新增 `hello.txt`，並更新 README。");
  await create.getByRole("button", { name: "建立" }).click();
  await expect(page).toHaveURL(/\/tasks\/[A-Z][A-Z0-9]+-\d+$/);
  const taskKey = page.url().split("/").pop() ?? "";

  await page.getByRole("button", { name: "新增 Acceptance Criterion" }).click();
  await page.locator(".ac-form").getByLabel("條件").fill("hello.txt 存在");
  await page.locator(".ac-form").getByRole("button", { name: "加入" }).click();
  await expect(page.locator(".ac-list > li")).toHaveCount(1);

  // 看板：Backlog → Ready，再拖到 Running 派工
  await page.goto("/board");
  const card = page.locator(`[data-task-key="${taskKey}"]`);
  const dragTo = async (status: string) => {
    const from = await card.boundingBox();
    const to = await page.locator(`.board-column[data-status="${status}"]`).boundingBox();
    if (!from || !to) throw new Error("找不到要拖曳的元素");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, {
      steps: 5,
    });
    await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 15 });
    await page.mouse.up();
  };
  await dragTo("ready");
  await expect(page.locator(`[data-status="ready"] [data-task-key="${taskKey}"]`)).toBeVisible();
  await dragTo("running");
  const dispatch = page.getByRole("dialog", { name: `派工 ${taskKey}` });
  await dispatch.getByRole("radio", { name: "我的電腦" }).check();
  await dispatch.getByRole("radio", { name: /^manual/ }).check();
  await dispatch.getByRole("button", { name: "派工" }).click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/);

  // 即時 Event：Worktree 建好、Agent 請求權限
  const timeline = page.getByTestId("timeline");
  await expect(timeline).toContainText("Worktree 已就緒");
  const request = timeline.locator('.event-permission[data-resolved="false"]').first();
  await expect(request).toBeVisible();
  await request.locator("button.primary").first().click();
  await expect(timeline.locator('.event-permission[data-resolved="true"]')).toHaveCount(1);

  // 第一回合結束，進入 Review Gate
  await expect(page.getByTestId("run-status")).toHaveText("等待 Gate");
  await page.getByRole("link", { name: "Diff review" }).click();
  await expect(page.getByTestId("diff-editor")).toBeVisible();

  // 在第一個檔案的第 1 行留言並退回
  await page.locator(".file-list button").first().click();
  await page.getByLabel("行號").fill("1");
  await page.getByLabel("留言內容").fill("請依照留言修改");
  await page.getByRole("button", { name: "加入留言" }).click();
  await page.getByRole("button", { name: /退回並附上留言/ }).click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/);
  const itemsBefore = Number(await timeline.getAttribute("data-item-count"));

  // 同一個 session 繼續，第二回合結束後再次進入 Review Gate
  await expect
    .poll(async () => Number(await timeline.getAttribute("data-item-count")))
    .toBeGreaterThan(itemsBefore + 1);
  await expect(page.getByTestId("run-status")).toHaveText("等待 Gate");

  // 核准：Task 進入 PR Open
  await page.getByRole("link", { name: "Diff review" }).click();
  await page.getByRole("button", { name: "核准並開 PR" }).click();
  await page.getByRole("link", { name: new RegExp(taskKey) }).click();
  await expect(page.locator(".page-header .status-badge")).toHaveText("PR Open");
});
