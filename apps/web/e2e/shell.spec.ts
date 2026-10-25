// 版面骨架與側欄（新工作區介面 PROMPTS 第 5a、5b 點）：Task 分區、搜尋、側欄寬度、個人選單、
// 主題與語言。

import { NAMES } from "@orbis/api-contract";
import { expect, gotoShell, openProfileMenuItem, test } from "./fixtures";

test.describe("側欄", () => {
  test("Task 依狀態分區，待辦與完成預設收合；有待我處理的 Task 用警告色", async ({ page }) => {
    await page.goto("/board");
    const sidebar = page.locator(".sidebar");
    const active = sidebar.getByRole("region", { name: /^進行中/ });
    await expect(active.getByRole("link")).toHaveText([
      /寫入 config\.json\s*ORB-3/,
      /整理 README\s*ORB-4/,
      /大量 Event 的 Run\s*ORB-6/,
    ]);
    await expect(active.getByRole("link", { name: "整理 README", exact: true })).toBeVisible();
    const backlog = sidebar.getByRole("button", { name: /^待辦/ });
    await expect(backlog).toHaveAttribute("aria-expanded", "false");
    await backlog.click();
    await expect(sidebar.getByRole("link", { name: /設定 CI 快取/ })).toBeVisible();
    await sidebar.getByRole("button", { name: /^進行中/ }).click();
    await expect(active.getByRole("link")).toHaveCount(0);

    await expect(page.getByTestId("needs-you-count")).toContainText("2");
  });

  test("Ctrl+K 搜尋：比對 Task Key 與標題，只有一筆時 Enter 開啟；Esc 清除", async ({ page }) => {
    await gotoShell(page, "/board");
    await page.keyboard.press("Control+k");
    const search = page.getByRole("searchbox", { name: "搜尋任務" });
    await expect(search).toBeFocused();
    await search.fill("readme");
    const rows = page.locator(".sidebar-row");
    await expect(rows).toHaveCount(2);
    await search.fill("ORB-3");
    await expect(rows).toHaveCount(1);
    await search.press("Enter");
    await expect(page).toHaveURL(/\/tasks\/ORB-3$/);
    await expect(page.locator('.sidebar-row[aria-current="page"]')).toContainText("ORB-3");

    await search.fill("找不到的字");
    await expect(page.getByText("沒有符合的任務")).toBeVisible();
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(search).not.toBeFocused();
  });

  test("側欄寬度 200–360px，←→ 每次 16px，雙擊重設，重新整理後保留", async ({ page }) => {
    await page.goto("/board");
    const sidebar = page.locator(".sidebar");
    const splitter = page.getByRole("separator", { name: "調整側欄寬度" });
    expect((await sidebar.boundingBox())?.width).toBe(252);
    await splitter.focus();
    await page.keyboard.press("ArrowRight");
    expect((await sidebar.boundingBox())?.width).toBe(268);
    for (let i = 0; i < 10; i += 1) await page.keyboard.press("ArrowRight");
    await expect(splitter).toHaveAttribute("aria-valuenow", "360");
    await page.reload();
    await expect(page.getByRole("separator", { name: "調整側欄寬度" })).toHaveAttribute(
      "aria-valuenow",
      "360",
    );
    await page.getByRole("separator", { name: "調整側欄寬度" }).dblclick();
    await expect(page.getByRole("separator", { name: "調整側欄寬度" })).toHaveAttribute(
      "aria-valuenow",
      "252",
    );
  });
});

test.describe("個人選單", () => {
  test("顯示名稱、Local Runner 與 Team Role；設定與執行器開設定對話框", async ({ page }) => {
    await page.goto("/board");
    const button = page.getByRole("button", { name: "個人選單" });
    await expect(button).toContainText("The Octocat");
    await expect(button).toContainText("octocat-laptop");
    await button.click();
    const menu = page.getByRole("menu", { name: "個人選單" });
    await expect(menu).toContainText("@octocat");
    await expect(menu.getByTestId("member-role")).toHaveText("擁有者");
    await expect(menu.getByRole("menuitem", { name: /執行器/ })).toContainText("octocat-laptop");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();

    await openProfileMenuItem(page, /執行器/);
    const dialog = page.getByRole("dialog", { name: "設定" });
    await expect(dialog.getByRole("tab", { name: "執行器" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.keyboard.press("Control+,");
    await expect(page.getByRole("tab", { name: "一般" })).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("Viewer 的個人選單", () => {
  test.use({ mock: { role: "viewer" } });

  test("看不到管理", async ({ page }) => {
    await page.goto("/board");
    await page.getByRole("button", { name: "個人選單" }).click();
    await expect(page.getByRole("menuitem", { name: "管理" })).toHaveCount(0);
    await expect(page.getByTestId("member-role")).toHaveText("檢視者");
  });
});

test.describe("主題與語言", () => {
  test("切換主題與語言，重新整理後保留，html 的 data-theme 與 lang 跟著換", async ({ page }) => {
    await gotoShell(page, "/board");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
    await page.keyboard.press("Control+,");
    const dialog = page.getByRole("dialog", { name: "設定" });
    await dialog.getByRole("radio", { name: "淺色" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await dialog.getByRole("radio", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Needs you/ })).toBeVisible();

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("searchbox", { name: "Search tasks" })).toBeVisible();
  });

  test("跟隨系統時依 prefers-color-scheme 即時切換", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(
      (key) => localStorage.setItem(key, "system"),
      `${NAMES.productSlug}-theme`,
    );
    await page.goto("/board");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});
