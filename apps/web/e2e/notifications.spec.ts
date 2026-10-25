// 通知中心（#43）：通知列表、已讀與未讀、即時推送、依事件類型的設定與勿擾時段。

import { allowPermission, dispatchTask, expect, test } from "./fixtures";

test("標頭顯示未讀數；列表可以只看未讀，點擊後前往相關頁面並標為已讀", async ({ page }) => {
  await page.goto("/board");
  await expect(page.getByTestId("notification-count")).toContainText("1");
  await page.getByRole("link", { name: /^通知/ }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  const items = page.locator(".notification");
  await expect(items).toHaveCount(2);
  const gate = items.filter({ hasText: "ORB-4 等待 Review Gate" });
  await expect(gate).toHaveAttribute("data-read", "false");
  await expect(items.filter({ hasText: "你被指派了 ORB-2" })).toHaveAttribute("data-read", "true");

  await page.getByRole("radio", { name: "未讀" }).click();
  await expect(items).toHaveCount(1);
  await items
    .first()
    .getByRole("button", { name: /ORB-4 等待 Review Gate/ })
    .click();
  await expect(page).toHaveURL(/\/runs\/run-\d+\/review$/);
  await expect(page.getByTestId("notification-count")).toHaveCount(0);
});

test("全部標為已讀", async ({ page }) => {
  await page.goto("/notifications");
  await page.getByRole("button", { name: "全部標為已讀" }).click();
  await expect(page.locator('.notification[data-read="false"]')).toHaveCount(0);
  await expect(page.getByTestId("notification-count")).toHaveCount(0);
  await page.getByRole("radio", { name: "未讀" }).click();
  await expect(page.getByText("沒有未讀的通知")).toBeVisible();
});

test("新的通知經由 WebSocket 即時出現（不需要重新整理）", async ({ page }) => {
  await dispatchTask(page, "ORB-2");
  await expect(page.getByTestId("notification-count")).toContainText("1");
  await allowPermission(page);
  // Verification 通過後進入 Review Gate，Server 推送 gate_pending
  await expect(page.getByTestId("notification-count")).toContainText("2");
  await page.getByRole("link", { name: /^通知/ }).click();
  await expect(page.locator(".notification").first()).toContainText("ORB-2 等待 Review Gate");
});

test("依事件類型關閉後不再收到；勿擾時段可以設定，開始與結束不能相同", async ({ page }) => {
  await page.goto("/notifications");
  await page.getByRole("button", { name: "通知設定" }).click();
  const dialog = page.getByRole("dialog", { name: "設定" });
  await expect(dialog.getByRole("tab", { name: "通知" })).toHaveAttribute("aria-selected", "true");
  const gate = dialog.getByRole("switch", { name: "關卡等待核准" });
  await gate.click();
  await expect(gate).toHaveAttribute("aria-checked", "false");
  await dialog.getByRole("switch", { name: "勿擾時段" }).click();
  await dialog.getByLabel("開始").fill("22:00");
  await dialog.getByLabel("結束").fill("22:00");
  await expect(dialog.getByRole("alert")).toContainText("開始與結束的時間不能相同");
  await dialog.getByLabel("結束").fill("07:30");
  await dialog.getByLabel("時區").selectOption("Asia/Taipei");
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  // 舊的通知設定網址開啟同一個設定分頁，設定已經保存
  await page.goto("/settings/notifications");
  await expect(page).toHaveURL(/\/notifications$/);
  const reopened = page.getByRole("dialog", { name: "設定" });
  await expect(reopened.getByRole("switch", { name: "關卡等待核准" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(reopened.getByLabel("結束")).toHaveValue("07:30");
  await expect(reopened.getByLabel("時區")).toHaveValue("Asia/Taipei");
  await page.keyboard.press("Escape");

  await dispatchTask(page, "ORB-2");
  await allowPermission(page);
  await expect(page.getByTestId("run-status")).toHaveText("等待審查關卡");
  await expect(page.getByTestId("notification-count")).toContainText("1");
});
