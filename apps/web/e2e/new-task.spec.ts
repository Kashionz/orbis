// 新增任務對話框（新工作區介面 PROMPTS 第 5h 點）。

import { expect, openNewTask, test } from "./fixtures";

test("條件齊備時建立後就緒；Ctrl+Enter 建立並開啟", async ({ page }) => {
  await page.goto("/board");
  const dialog = await openNewTask(page);
  await expect(dialog.getByRole("textbox", { name: "任務標題" })).toBeFocused();
  await expect(dialog).toContainText("ORB-8");
  const create = dialog.getByRole("button", { name: "建立", exact: true });
  await expect(create).toBeDisabled();

  await dialog.getByRole("textbox", { name: "任務標題" }).fill("修正 Windows 換行");
  const status = dialog.getByTestId("new-task-status");
  await expect(status).toContainText("待辦");
  await expect(status).toContainText("描述或規格");
  await expect(status).toContainText("至少一條驗收條件");
  await expect(create).toBeEnabled();

  await dialog.getByRole("textbox", { name: "描述要做什麼" }).fill("差異預覽要正確處理 CRLF。");
  await dialog.getByRole("textbox", { name: "條件描述" }).fill("只顯示真正的變更");
  await dialog.getByRole("textbox", { name: "指令" }).fill("pnpm test");
  await expect(status).toHaveText("就緒");

  // 第二條條件改成人工確認，指令欄位消失
  await dialog.getByRole("button", { name: "新增條件" }).click();
  await dialog.getByRole("textbox", { name: "條件描述" }).nth(1).fill("畫面正確");
  await dialog.getByRole("button", { name: "條件類型：代理判定" }).click();
  const kinds = page.getByRole("menu", { name: "條件類型" });
  await expect(kinds.getByRole("menuitemradio", { name: /人工/ })).toContainText(
    "在審查關卡由人工確認",
  );
  await kinds.getByRole("menuitemradio", { name: /人工/ }).click();
  await expect(dialog.getByRole("textbox", { name: "指令" })).toHaveCount(1);
  await expect(dialog.locator(".new-task-count")).toHaveText("2");

  // 依賴與指派對象
  await dialog.getByRole("button", { name: /^依賴/ }).click();
  await page.getByRole("menuitemradio", { name: /ORB-1/ }).click();
  await expect(dialog.getByRole("button", { name: /^依賴/ })).toContainText("ORB-1");
  await dialog.getByRole("button", { name: /^指派對象/ }).click();
  await page.getByRole("menuitemradio", { name: "alice" }).click();
  await expect(dialog.getByRole("button", { name: /^指派對象/ })).toContainText("alice");

  await dialog.getByRole("textbox", { name: "任務標題" }).press("Control+Enter");
  await expect(page).toHaveURL(/\/tasks\/ORB-8$/);
  await expect(page.getByText("已建立 ORB-8")).toBeVisible();
  // 條件齊備：建立兩條驗收條件後轉就緒
  await expect(
    page
      .locator(".sidebar")
      .getByRole("region", { name: /^就緒/ })
      .getByRole("link", { name: "修正 Windows 換行" }),
  ).toBeVisible();
});

test("「建立」留在原頁面；Esc 關閉對話框", async ({ page }) => {
  await page.goto("/board");
  let dialog = await openNewTask(page);
  await dialog.getByRole("textbox", { name: "任務標題" }).fill("只有標題");
  await dialog.getByRole("button", { name: "建立", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/board/);
  await expect(page.locator('.sidebar-row:has-text("ORB-8")')).toHaveCount(0);
  await page.locator(".sidebar").getByRole("button", { name: /^待辦/ }).click();
  await expect(page.locator(".sidebar-row", { hasText: "只有標題" })).toBeVisible();

  dialog = await openNewTask(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test.describe("不指定儲存庫", () => {
  test("後端支援時可以選「尚未指定」，任務停在待辦", async ({ page }) => {
    await page.goto("/board");
    const dialog = await openNewTask(page);
    await dialog.getByRole("textbox", { name: "任務標題" }).fill("之後再決定儲存庫");
    await dialog.getByRole("button", { name: /^儲存庫/ }).click();
    await page.getByRole("menuitemradio", { name: "尚未指定" }).click();
    await expect(dialog.getByTestId("new-task-status")).toContainText("指定儲存庫");
    await dialog.getByRole("button", { name: /^建立並開啟/ }).click();
    await expect(page).toHaveURL(/\/tasks\/ORB-8$/);
  });
});
