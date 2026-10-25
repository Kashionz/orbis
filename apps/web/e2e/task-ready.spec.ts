// #59：Task 頁顯示進入 Ready 還缺什麼，並提供改狀態的操作（看板拖曳以外的入口）。

import { createTask, expect, test } from "./fixtures";

test.describe("Task 頁的 Ready 條件", () => {
  test("新 Task 列出還缺的項目；補上 Acceptance Criterion 後打勾", async ({ page }) => {
    await page.goto("/board");
    await createTask(page, { title: "還沒寫完的 Task" });
    await expect(page).toHaveURL(/\/tasks\/ORB-\d+$/);

    const panel = page.locator(".ready-panel");
    await expect(panel.getByRole("heading")).toHaveText("進入 Ready 的條件");
    const items = panel.locator(".ready-checklist li");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toHaveAttribute("data-met", "true");
    await expect(items.nth(1)).toHaveAttribute("data-met", "false");
    await expect(items.nth(2)).toHaveAttribute("data-met", "false");
    await expect(panel).toContainText("還缺：描述或規格、至少一條驗收條件");
    await expect(panel.getByRole("button", { name: "移到 Ready" })).toBeDisabled();

    await page.getByRole("button", { name: "新增 Acceptance Criterion" }).click();
    await page.locator(".ac-form").getByLabel("類型").selectOption("manual");
    await page.locator(".ac-form").getByLabel("條件").fill("畫面正確");
    await page.locator(".ac-form").getByRole("button", { name: "加入" }).click();
    await expect(items.nth(2)).toHaveAttribute("data-met", "true");
    await expect(panel).toContainText("還缺：描述或規格");
  });

  test("條件齊備時從 Task 頁移到 Ready，也可以移回 Backlog", async ({ page }) => {
    await page.goto("/tasks/ORB-1");
    const badge = page.locator(".page-header .status-badge");
    await expect(badge).toHaveText("待辦");
    const panel = page.locator(".ready-panel");
    await panel.getByRole("button", { name: "移到 Ready" }).click();
    await expect(badge).toHaveText("就緒");
    await expect(panel.getByRole("heading")).toHaveText("已進入 Ready");
    await expect(page.getByRole("button", { name: "派工" })).toBeVisible();

    await panel.getByRole("button", { name: "移回 Backlog" }).click();
    await expect(badge).toHaveText("待辦");
    await page.goto("/board");
    await expect(page.locator('[data-status="backlog"] [data-task-key="ORB-1"]')).toBeVisible();
  });

  test.describe("Viewer", () => {
    test.use({ mock: { role: "viewer" } });

    test("看得到還缺什麼，但沒有改狀態的按鈕", async ({ page }) => {
      await page.goto("/tasks/ORB-1");
      const panel = page.locator(".ready-panel");
      await expect(panel.locator(".ready-checklist li")).toHaveCount(3);
      await expect(panel.getByRole("button")).toHaveCount(0);
    });
  });
});
