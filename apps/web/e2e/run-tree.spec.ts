// Child Run 樹（#44）：任務分頁的執行紀錄以樹狀顯示 Run 與 Child Run，可以中止任一節點、
// 點擊節點在工作區切換到那個 Run。

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test.use({ mock: { eventIntervalMs: 20, childRuns: true } });

const row = (page: Page, runId: string) => page.locator(`.rp-run[data-run-id="${runId}"]`);

test("樹狀顯示代理、模型、狀態、來源；點節點在工作區切換到那個 Run", async ({ page }) => {
  await page.goto("/tasks/ORB-4");
  const tree = page.getByRole("list", { name: "執行紀錄" });
  await expect(tree.locator(".rp-run")).toHaveCount(5);
  await expect(row(page, "run-child-api")).toHaveAttribute("data-depth", "1");
  const api = row(page, "run-child-api");
  await expect(api).toContainText("codex");
  await expect(api).toContainText("gpt-5");
  await expect(api).toContainText("執行中");
  await expect(api).toContainText("委派");
  await expect(api).toContainText("分支（子分支）");
  await expect(row(page, "run-child-api-review")).toHaveAttribute("data-depth", "2");

  await api.locator(".rp-run-open").click();
  await expect(page).toHaveURL(/\/tasks\/ORB-4\?run=run-child-api$/);
  await expect(page.getByTestId("timeline")).toContainText("run-child-api：開始處理。");
  await expect(row(page, "run-child-api")).toHaveAttribute("data-current", "true");
  await expect(page.locator(".wk-header-parent")).toBeVisible();

  // 換選另一個節點
  await row(page, "run-child-docs").locator(".rp-run-open").click();
  await expect(page.getByTestId("timeline")).toContainText("run-child-docs：完成了。");
});

test("可以單獨中止 Child Run，父 Run 與 Task 不受影響", async ({ page }) => {
  await page.goto("/tasks/ORB-4");
  const api = row(page, "run-child-api");
  await api.getByRole("button", { name: "中止 run-child-api" }).click();
  await expect(api).toContainText("已中止");
  await expect(api.getByRole("button", { name: /^中止/ })).toHaveCount(0);
  await expect(page.locator(".rp-run").first()).toContainText("等待關卡");
  await expect(page.locator(".rp-status")).toHaveText("審查關卡");
  // 已完成的節點沒有中止按鈕
  await expect(row(page, "run-child-docs").getByRole("button", { name: /^中止/ })).toHaveCount(0);
});

test("中止父 Run 時連同還在執行的 Child Run 一起中止", async ({ page }) => {
  await page.goto("/tasks/ORB-4");
  await page.locator(".rp-run").first().getByRole("button", { name: /^中止/ }).click();
  await expect(row(page, "run-child-api")).toContainText("已中止");
  await expect(row(page, "run-child-ask")).toContainText("已中止");
  await expect(row(page, "run-child-docs")).toContainText("已完成");
});

test("Child Run 的問題在 Needs You 由人回答", async ({ page }) => {
  await page.goto("/needs-you");
  const item = page.locator('.ny-row[data-kind="child_question"]');
  await expect(item).toContainText("README 要用中文還是英文？");
  await item.getByLabel("回答", { exact: true }).fill("用中文");
  await item.getByRole("button", { name: "回答" }).click();
  await expect(item).toHaveCount(0);
  await page.goto("/runs/run-child-ask");
  await expect(page.getByTestId("timeline")).toContainText("用中文");
});

test.describe("Viewer", () => {
  test.use({ mock: { eventIntervalMs: 20, childRuns: true, role: "viewer" } });

  test("看得到樹但沒有中止按鈕", async ({ page }) => {
    await page.goto("/tasks/ORB-4");
    await expect(page.locator(".rp-run")).toHaveCount(5);
    await expect(page.locator(".rp-runs").getByRole("button", { name: /^中止/ })).toHaveCount(0);
  });
});
