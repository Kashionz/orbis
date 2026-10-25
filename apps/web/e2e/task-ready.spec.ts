// #59：工作區還沒有執行時顯示進入就緒還缺什麼，並提供改狀態的操作（看板拖曳以外的入口）。

import { createTask, expect, test } from "./fixtures";

test.describe("就緒的條件", () => {
  test("新 Task 列出還缺的項目；補上驗收條件後打勾", async ({ page }) => {
    await page.goto("/board");
    await createTask(page, { title: "還沒寫完的 Task" });
    await expect(page).toHaveURL(/\/tasks\/ORB-8$/);

    const items = page.locator(".wk-checklist li");
    await expect(page.locator(".wk-norun")).toContainText("進入就緒前還缺少");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toHaveAttribute("data-met", "true");
    await expect(items.nth(1)).toHaveAttribute("data-met", "false");
    await expect(items.nth(2)).toHaveAttribute("data-met", "false");
    await expect(page.getByRole("button", { name: "移到就緒" })).toBeDisabled();

    await page.getByRole("tabpanel").getByRole("button", { name: "編輯", exact: true }).click();
    await page.getByRole("button", { name: "新增條件" }).click();
    await page.locator(".rp-draft").getByLabel("條件描述").fill("畫面正確");
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await expect(items.nth(2)).toHaveAttribute("data-met", "true");
    await expect(items.nth(1)).toHaveAttribute("data-met", "false");
  });

  test("條件齊備時從工作區移到就緒，也可以移回待辦", async ({ page }) => {
    await page.goto("/tasks/ORB-1");
    const status = page.locator(".rp-status");
    await expect(status).toHaveText("待辦");
    await page.getByRole("button", { name: "移到就緒" }).click();
    await expect(status).toHaveText("就緒");
    await expect(page.getByRole("form", { name: "派工" })).toBeVisible();

    await page.getByRole("button", { name: "移回待辦" }).click();
    await expect(status).toHaveText("待辦");
    await page.goto("/board");
    await expect(page.locator('[data-status="backlog"] [data-task-key="ORB-1"]')).toBeVisible();
  });

  test.describe("Viewer", () => {
    test.use({ mock: { role: "viewer" } });

    test("看得到還缺什麼，但沒有改狀態的按鈕", async ({ page }) => {
      await page.goto("/tasks/ORB-1");
      await expect(page.locator(".wk-checklist li")).toHaveCount(3);
      await expect(page.locator(".wk-norun").getByRole("button")).toHaveCount(0);
    });
  });
});
