import { CONFIG_PATH } from "../src/mocks/scripts";
import { expect, test } from "./fixtures";

test.describe("Needs You", () => {
  test("列出等待自己處理的權限請求與 Review Gate，頂部顯示數量", async ({ page }) => {
    await page.goto("/needs-you");
    const items = page.locator(".needs-you-item");
    await expect(items).toHaveCount(2);
    await expect(page.getByTestId("needs-you-count")).toContainText("2");
    await expect(items.nth(0)).toHaveAttribute("data-kind", "permission_request");
    await expect(items.nth(0)).toContainText("ORB-3");
    await expect(items.nth(0)).toContainText("寫入 config.json");
    await expect(items.nth(1)).toHaveAttribute("data-kind", "gate");
    await expect(items.nth(1)).toContainText("Review Gate");
  });

  test("權限請求一鍵跳到 Run 頁並標示那筆請求", async ({ page }) => {
    await page.goto("/needs-you");
    await page
      .locator(".needs-you-item", { hasText: "ORB-3" })
      .getByRole("link", { name: "前往 Run" })
      .click();
    await expect(page).toHaveURL(/\/runs\/run-\d+\?focus=permission-perm-write-config$/);
    const focused = page.locator('.timeline-row[data-focused="true"]');
    await expect(focused).toContainText("權限請求");
    await expect(focused.getByRole("button", { name: "允許" })).toBeVisible();
  });

  test("Review Gate 一鍵跳到 diff review", async ({ page }) => {
    await page.goto("/needs-you");
    await page.getByRole("link", { name: "前往 diff review" }).click();
    await expect(page).toHaveURL(/\/runs\/run-\d+\/review$/);
    await expect(page.getByRole("heading", { name: "Diff review" })).toBeVisible();
  });

  test("在清單中直接回覆權限請求，項目消失", async ({ page }) => {
    await page.goto("/needs-you");
    const item = page.locator(".needs-you-item", { hasText: "ORB-3" });
    await item.getByRole("button", { name: "允許" }).click();
    await expect(item).toHaveCount(0);
    await expect(page.getByTestId("needs-you-count")).toContainText("1");
  });
});

test.describe("設定的信任核准", () => {
  test.use({ mock: { configTrust: true } });

  test("依 purpose 標示為設定的信任核准，Admin 以上可以在清單中回覆", async ({ page }) => {
    await page.goto("/needs-you");
    const item = page.locator('.needs-you-item[data-purpose="config_trust"]');
    await expect(item).toContainText("設定的信任核准");
    await expect(item).toContainText(`執行 ${CONFIG_PATH} 的 setup`);
    await item.getByRole("button", { name: "信任並執行" }).click();
    await expect(item).toHaveCount(0);
  });

  test.describe("Role 為 Member", () => {
    test.use({ mock: { configTrust: true, role: "member" } });

    test("清單中沒有這個項目，Run 頁顯示等待 Admin 以上回覆", async ({ page }) => {
      await page.goto("/needs-you");
      await expect(page.locator(".needs-you-item").first()).toBeVisible();
      await expect(page.locator('.needs-you-item[data-purpose="config_trust"]')).toHaveCount(0);

      await page.goto("/tasks/ORB-8");
      await page.getByRole("link", { name: /^run-/ }).click();
      const request = page.locator('.event-permission[data-purpose="config_trust"]');
      await expect(request).toContainText("設定的信任核准");
      await expect(request).toContainText("等待 Admin 以上的 Member 回覆");
      await expect(request.getByRole("button")).toHaveCount(0);
    });
  });
});
