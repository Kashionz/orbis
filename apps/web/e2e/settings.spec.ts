// 設定對話框（新工作區介面 PROMPTS 第 5j 點）。

import { expect, gotoShell, openProfileMenuItem, test } from "./fixtures";

async function openSettings(page: import("@playwright/test").Page, tab: string) {
  await gotoShell(page, "/board");
  await page.keyboard.press("Control+,");
  const dialog = page.getByRole("dialog", { name: "設定" });
  await dialog.getByRole("tab", { name: tab }).click();
  return dialog;
}

test("左側導覽可以用上下鍵切換分頁；一般分頁顯示版本", async ({ page }) => {
  const dialog = await openSettings(page, "一般");
  await expect(dialog.getByTestId("settings-version")).toContainText("伺服器");
  await dialog.getByRole("tab", { name: "一般" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("tab", { name: "執行器" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog.getByRole("tabpanel")).toContainText("預設終端");
});

test("預設版面與自動展開工具步驟存在這台裝置", async ({ page }) => {
  const dialog = await openSettings(page, "一般");
  await dialog.getByRole("radio", { name: "僅串流" }).click();
  const auto = dialog.getByRole("switch", { name: "自動展開工具步驟" });
  await auto.click();
  await page.reload();
  await expect(page.getByRole("button", { name: "個人選單" })).toBeVisible();
  await page.keyboard.press("Control+,");
  const reopened = page.getByRole("dialog", { name: "設定" });
  await expect(reopened.getByRole("radio", { name: "僅串流" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(reopened.getByRole("switch", { name: "自動展開工具步驟" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("執行器：清單、預設終端、Windows 長路徑、產生配對碼", async ({ page }) => {
  const dialog = await openSettings(page, "執行器");
  const local = dialog.locator('[data-runner="octocat-laptop"]');
  await expect(local).toContainText("本機");
  await expect(local).toContainText("已連線");
  await expect(dialog.locator('[data-runner="alice-mac"]')).toContainText("離線");

  await dialog.getByRole("radio", { name: "Git Bash" }).click();
  await expect(dialog.getByRole("radio", { name: "Git Bash" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  const longPaths = dialog.getByRole("switch", { name: "Windows 長路徑" });
  await expect(longPaths).toHaveAttribute("aria-checked", "true");
  await longPaths.click();
  await expect(longPaths).toHaveAttribute("aria-checked", "false");

  await dialog.getByRole("button", { name: "配對新的執行器" }).click();
  await page.getByRole("menuitem", { name: /團隊執行器/ }).click();
  await expect(dialog.getByTestId("pairing-token")).not.toBeEmpty();
  await expect(dialog.getByRole("status")).toContainText("團隊");
});

test("代理：登入狀態、重新登入、預設模型", async ({ page }) => {
  const dialog = await openSettings(page, "代理");
  const antigravity = dialog.locator('[data-agent="antigravity"]');
  await expect(antigravity).toContainText("需要重新登入");
  await antigravity.getByRole("button", { name: "重新登入" }).click();
  await expect(page.getByText("正在開啟 Antigravity 登入")).toBeVisible();
  await expect(antigravity).toContainText("已登入");

  const claude = dialog.locator('[data-agent="claude-code"]');
  await claude.getByRole("button", { name: /Claude Code 的預設模型/ }).click();
  const menu = page.getByRole("menu", { name: "Claude Code 的預設模型" });
  await expect(menu.getByRole("menuitemradio", { name: /Sonnet 5\.5/ })).toContainText("平衡");
  await menu.getByRole("menuitemradio", { name: /Sonnet 5\.5/ }).click();
  await expect(claude.getByRole("button", { name: /Claude Code 的預設模型/ })).toHaveText(
    "Sonnet 5.5",
  );
});

test("帳號：修改團隊名稱後側欄跟著換；可以登出", async ({ page }) => {
  const dialog = await openSettings(page, "帳號");
  await expect(dialog).toContainText("@octocat");
  await expect(dialog).toContainText("3 成員");
  const team = dialog.getByRole("textbox", { name: "團隊名稱" });
  await team.fill("Kash 小隊");
  await team.press("Enter");
  await expect(page.locator(".sidebar-team")).toHaveText("Kash 小隊");

  await dialog.getByRole("button", { name: "登出" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test.describe("Member", () => {
  test.use({ mock: { role: "member" } });

  test("團隊名稱唯讀，不能產生團隊執行器的配對碼", async ({ page }) => {
    const dialog = await openSettings(page, "帳號");
    await expect(dialog.getByRole("textbox", { name: "團隊名稱" })).toHaveAttribute("readonly");
    await dialog.getByRole("tab", { name: "執行器" }).click();
    await dialog.getByRole("button", { name: "配對新的執行器" }).click();
    await expect(page.getByRole("menuitem", { name: /本機執行器/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /團隊執行器/ })).toHaveCount(0);
  });
});

test.describe("後端還沒有的設定", () => {
  test.use({
    mock: { features: { runnerLongPaths: false, agentRelogin: false, desktopNotifyToggle: false } },
  });

  test("停用並顯示尚未開放", async ({ page }) => {
    const dialog = await openSettings(page, "執行器");
    const longPaths = dialog.getByRole("switch", { name: "Windows 長路徑" });
    await expect(longPaths).toHaveAttribute("aria-disabled", "true");
    await longPaths.hover();
    await expect(page.getByRole("tooltip")).toHaveText("尚未開放");

    await dialog.getByRole("tab", { name: "代理" }).click();
    await expect(dialog.getByRole("button", { name: "重新登入" })).toBeDisabled();
    await dialog.getByRole("tab", { name: "通知" }).click();
    await expect(dialog.getByRole("switch", { name: "桌面通知" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

test("個人選單的登出", async ({ page }) => {
  await page.goto("/board");
  await openProfileMenuItem(page, "登出");
  await expect(page).toHaveURL(/\/login$/);
});
