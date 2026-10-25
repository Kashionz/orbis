// Server↔Web 的版本相容（ARCHITECTURE §16）：/api/health 回報的 API 版本和 Web 不同時，頁面頂端提示要怎麼做。

import { expect, test } from "./fixtures";

test.describe("版本相同", () => {
  test("沒有版本提示", async ({ page }) => {
    await page.goto("/board");
    await expect(page.getByRole("navigation", { name: "主要導覽" })).toBeVisible();
    await expect(page.getByTestId("version-banner")).toHaveCount(0);
  });
});

test.describe("瀏覽器快取了舊的 Web", () => {
  test.use({ mock: { health: "web-outdated" } });

  test("提示重新整理，按鈕會重新載入頁面", async ({ page }) => {
    await page.goto("/board");
    const banner = page.getByTestId("version-banner");
    await expect(banner).toContainText("介面有新版本，請重新整理");
    await expect(banner).toHaveAttribute("data-kind", "reload");
    const reloaded = page.waitForEvent("load");
    await banner.getByRole("button", { name: "重新整理" }).click();
    await reloaded;
  });
});

test.describe("Server 比 Web 舊", () => {
  test.use({ mock: { health: "server-outdated" } });

  test("提示更新 Server，沒有重新整理的按鈕", async ({ page }) => {
    await page.goto("/board");
    const banner = page.getByTestId("version-banner");
    await expect(banner).toContainText("伺服器版本過舊，請更新伺服器");
    await expect(banner).toHaveAttribute("data-kind", "update_server");
    await expect(banner.getByRole("button")).toHaveCount(0);
  });
});

test.describe("伺服器沒有回報版本", () => {
  test.use({ mock: { health: "no-versions" } });

  test("視為 Server 過舊", async ({ page }) => {
    await page.goto("/board");
    await expect(page.getByTestId("version-banner")).toContainText("伺服器沒有回報版本");
  });
});
