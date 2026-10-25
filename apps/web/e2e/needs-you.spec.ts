import type { Page } from "@playwright/test";
import { CONFIG_PATH } from "../src/mocks/scripts";
import { expect, stream, test } from "./fixtures";

const rows = (page: Page) => page.locator(".ny-row");

test.describe("待我處理", () => {
  test("依類型分組列出權限請求與審查關卡，側欄顯示數量", async ({ page }) => {
    await page.goto("/needs-you");
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByTestId("needs-you-count")).toContainText("2");
    await expect(page.getByRole("heading", { name: "權限請求" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "審查關卡" })).toBeVisible();
    await expect(rows(page).nth(0)).toHaveAttribute("data-kind", "permission_request");
    await expect(rows(page).nth(0)).toContainText("ORB-3");
    await expect(rows(page).nth(0)).toContainText("寫入 config.json");
    await expect(rows(page).nth(1)).toHaveAttribute("data-kind", "gate");
    await expect(rows(page).nth(1)).toContainText("等待審查差異");
  });

  test("權限請求一鍵跳到工作區並標示那筆請求", async ({ page }) => {
    await page.goto("/needs-you");
    await rows(page).filter({ hasText: "ORB-3" }).getByRole("button", { name: "前往執行" }).click();
    await expect(page).toHaveURL(/\/tasks\/ORB-3\?run=run-\d+&focus=permission-perm-write-config$/);
    const focused = stream(page).locator('.st-item[data-focused="true"]');
    await expect(focused).toContainText("權限請求");
    await expect(focused.getByRole("button", { name: "允許一次" })).toBeVisible();
  });

  test("審查關卡一鍵跳到差異分頁", async ({ page }) => {
    await page.goto("/needs-you");
    await page.getByRole("button", { name: "前往差異審查" }).click();
    await expect(page).toHaveURL(/\/tasks\/ORB-4\?run=run-\d+&tab=diff$/);
    await expect(page.getByRole("tab", { name: /差異/ })).toHaveAttribute("aria-selected", "true");
  });

  test("在清單中直接回覆權限請求，項目消失", async ({ page }) => {
    await page.goto("/needs-you");
    const item = rows(page).filter({ hasText: "ORB-3" });
    await item.getByRole("button", { name: "允許一次" }).click();
    await expect(item).toHaveCount(0);
    await expect(page.getByTestId("needs-you-count")).toContainText("1");
  });
});

test.describe("設定的信任核准", () => {
  test.use({ mock: { configTrust: true } });

  test("依 purpose 標示為設定的信任核准，Admin 以上可以在清單中回覆", async ({ page }) => {
    await page.goto("/needs-you");
    const item = page.locator('.ny-row[data-purpose="config_trust"]');
    await expect(item).toContainText("設定的信任核准");
    await expect(item).toContainText(`執行 ${CONFIG_PATH} 的 setup`);
    await item.locator(".st-option").first().click();
    await expect(item).toHaveCount(0);
  });

  test.describe("Role 為 Member", () => {
    test.use({ mock: { configTrust: true, role: "member" } });

    test("清單中沒有這個項目，工作區顯示等待管理員以上回覆", async ({ page }) => {
      await page.goto("/needs-you");
      await expect(rows(page).first()).toBeVisible();
      await expect(page.locator('.ny-row[data-purpose="config_trust"]')).toHaveCount(0);

      await page.goto("/tasks/ORB-8");
      const request = stream(page).locator('.st-perm[data-purpose="config_trust"]');
      await expect(request).toContainText("設定的信任核准");
      await expect(request).toContainText("等待管理員以上的成員回覆");
      await expect(request.locator(".st-option")).toHaveCount(0);
    });
  });
});
