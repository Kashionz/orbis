// M1 路徑在 MSW 假後端上走一次（開發期間的鷹架）。
// 完成條件要求的版本跑在真實 Server + Runner + Fake Agent 上：e2e/system/m1-path.spec.ts。

import { card, column, createTask, dragTo, drop, expect, stream, test } from "./fixtures";

test("M1 路徑：建立 Task → 派工 → 即時事件 → 回覆權限請求 → diff 留言退回 → 核准", async ({
  page,
}) => {
  // 從看板的新增任務對話框建立，建立後開啟工作區
  await page.goto("/board");
  await createTask(page, {
    title: "M1：新增 hello.txt",
    description: "新增 `hello.txt`，並更新 README。",
  });
  await expect(page).toHaveURL(/\/tasks\/ORB-8$/);

  // 進入就緒需要至少一條驗收條件：在任務分頁的內嵌編輯新增
  await page.getByRole("tabpanel").getByRole("button", { name: "編輯", exact: true }).click();
  await page.getByRole("button", { name: "新增條件" }).click();
  await page.locator(".rp-draft").getByLabel("條件描述").fill("測試通過");
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(page.locator(".rp-criterion")).toHaveCount(1);

  // 待辦 → 就緒 → 拖到執行中派工
  await page.goto("/board");
  await page.getByRole("radio", { name: "分欄" }).click();
  await dragTo(page, card(page, "ORB-8"), column(page, "ready"));
  await drop(page);
  await expect(column(page, "ready").locator('[data-task-key="ORB-8"]')).toBeVisible();
  await dragTo(page, card(page, "ORB-8"), column(page, "running"));
  await drop(page);
  await page
    .getByRole("dialog", { name: "派工 ORB-8" })
    .getByRole("button", { name: "派工" })
    .click();
  await expect(page).toHaveURL(/\/tasks\/ORB-8\?run=run-\d+$/);

  // 即時事件與權限請求
  await expect(stream(page)).toContainText("我需要寫入 config.json。");
  await stream(page).locator(".st-perm").getByRole("button", { name: "允許一次" }).click();
  await expect(stream(page)).toContainText("完成了。");

  // diff 留言退回
  await page.getByRole("button", { name: "開啟差異審查" }).click();
  await page
    .locator(".rp-file-tabs")
    .getByRole("button", { name: /README\.md/ })
    .click();
  await page.getByRole("button", { name: "對修改後第 3 行留言", exact: true }).click();
  await page.getByRole("combobox", { name: "對修改後第 3 行留言" }).fill("請補充說明");
  await page.getByRole("button", { name: "加入留言" }).click();
  await page.getByRole("button", { name: /^退回（/ }).click();
  await expect(stream(page)).toContainText("已依照留言修改。");

  // 第二次審查：看到修改後的內容，核准
  await expect(page.getByTestId("run-status")).toHaveText("等待審查關卡");
  await page
    .locator(".rp-file-tabs")
    .getByRole("button", { name: /README\.md/ })
    .click();
  await expect(page.locator(".rp-file")).toContainText("依照 review 留言補上說明");
  await page.getByRole("button", { name: "核准並開啟合併請求" }).click();
  await expect(page.getByTestId("run-status")).toHaveText("已完成");

  await page.goto("/board");
  await expect(page.locator('[data-status="pr_open"] [data-task-key="ORB-8"]')).toBeVisible();
});
