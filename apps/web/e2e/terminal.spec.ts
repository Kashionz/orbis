// 互動式終端機（ADR-0014、ARCHITECTURE §6.5）：在 Run 的 Worktree 開 shell，輸入輸出經由終端機的 WebSocket；
// 關閉分頁就關閉終端機。mock 的 shell 回顯輸入，`exit` 結束。

import { expect, test } from "./fixtures";

test("開新終端機、輸入指令、結束後顯示原因；關閉分頁回到代理指令", async ({ page }) => {
  await page.goto("/tasks/ORB-3");
  await page.getByRole("tab", { name: "終端機", exact: true }).click();
  await expect(page.getByRole("tab", { name: "代理指令" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByRole("button", { name: "開新終端機" }).click();
  await expect(page.getByRole("tab", { name: "終端機 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const terminal = page.getByTestId("interactive-terminal");
  await expect(terminal).toContainText("PS C:\\orbis\\worktree>");
  await terminal.click();
  await page.keyboard.type("git status");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("git status");

  // 第二個終端機，關閉後回到代理指令
  await page.getByRole("button", { name: "開新終端機" }).click();
  await expect(page.getByRole("tab", { name: "終端機 2" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "關閉終端機 2" }).click();
  await expect(page.getByRole("tab", { name: "終端機 2" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "代理指令" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByRole("tab", { name: "終端機 1" }).click();
  await terminal.click();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "終端機已結束" })).toHaveText(
    "終端機已結束（shell 已結束）",
  );
});

test.describe("Viewer", () => {
  test.use({ mock: { role: "viewer" } });

  test("沒有開新終端機的按鈕", async ({ page }) => {
    await page.goto("/tasks/ORB-3");
    await page.getByRole("tab", { name: "終端機", exact: true }).click();
    await expect(page.getByRole("tab", { name: "代理指令" })).toBeVisible();
    await expect(page.getByRole("button", { name: "開新終端機" })).toHaveCount(0);
  });
});
