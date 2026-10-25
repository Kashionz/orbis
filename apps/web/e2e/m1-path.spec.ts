// M1 路徑在 MSW 假後端上走一次（開發期間的鷹架）。
// 完成條件要求的版本跑在真實 Server + Runner + Fake Agent 上：e2e/system/m1-path.spec.ts。

import { card, column, createTask, dragTo, drop, expect, test } from "./fixtures";

test("M1 路徑：建立 Task → 派工 → 即時 Event → 回覆權限請求 → diff 留言退回 → 核准", async ({
  page,
}) => {
  // 建立 Task
  await page.goto("/board");
  await createTask(page, {
    title: "M1：新增 hello.txt",
    description: "新增 `hello.txt`，並更新 README。",
  });
  await expect(page).toHaveURL(/\/tasks\/ORB-8$/);

  // 進入 Ready 需要至少一條 Acceptance Criterion
  await page.getByRole("button", { name: "新增 Acceptance Criterion" }).click();
  await page.locator(".ac-form").getByLabel("條件").fill("測試通過");
  await page.locator(".ac-form").getByRole("button", { name: "加入" }).click();
  await expect(page.locator(".ac-list > li")).toHaveCount(1);

  // Backlog → Ready → 拖到 Running 派工
  await page.getByRole("link", { name: "核心產品" }).click();
  await dragTo(page, card(page, "ORB-8"), column(page, "ready"));
  await drop(page);
  await expect(column(page, "ready").locator('[data-task-key="ORB-8"]')).toBeVisible();
  await dragTo(page, card(page, "ORB-8"), column(page, "running"));
  await drop(page);
  await page
    .getByRole("dialog", { name: "派工 ORB-8" })
    .getByRole("button", { name: "派工" })
    .click();

  // 即時 Event 與權限請求
  const timeline = page.getByTestId("timeline");
  await expect(timeline).toContainText("我需要寫入 config.json。");
  await timeline.locator(".event-permission").getByRole("button", { name: "允許" }).click();
  await expect(timeline).toContainText("完成了。");

  // diff 留言退回
  await page.getByRole("link", { name: "Diff review" }).click();
  await page
    .locator(".file-list")
    .getByRole("button", { name: /README\.md/ })
    .click();
  await page.getByLabel("行號").fill("3");
  await page.getByLabel("留言內容").fill("請補充說明");
  await page.getByRole("button", { name: "加入留言" }).click();
  await page.getByRole("button", { name: /退回並附上留言/ }).click();
  await expect(timeline).toContainText("已依照留言修改。");

  // 第二次 review：看到修改後的內容，核准
  await page.getByRole("link", { name: "Diff review" }).click();
  await page
    .locator(".file-list")
    .getByRole("button", { name: /README\.md/ })
    .click();
  await expect(page.locator(".editor.modified .view-lines")).toContainText(
    "依照 review 留言補上說明",
  );
  await page.getByRole("button", { name: "核准並開 PR" }).click();
  await expect(page.getByTestId("run-status")).toHaveText("已完成");

  await page.goto("/board");
  await expect(column(page, "pr_open").locator('[data-task-key="ORB-8"]')).toBeVisible();
});
