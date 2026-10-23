import { NAMES, TASK_STATUSES } from "@orbis/api-contract";
import { DESKTOP_BRIDGE_KEY } from "@orbis/desktop/bridge";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** 模擬 Desktop 的 bridge：記錄 beforeLogout() 的呼叫，回傳指定的結果。 */
async function installBridge(page: Page, proceed: boolean): Promise<void> {
  await page.addInitScript(
    ({ key, proceed }) => {
      const calls: string[] = [];
      Object.assign(window, { __bridgeCalls: calls });
      Object.assign(window, {
        [key]: {
          getVersion: async () => "0.0.0",
          openWorktreeInEditor: async () => ({ ok: true }),
          openWorktreeInTerminal: async () => ({ ok: true }),
          beforeLogout: async () => {
            calls.push("beforeLogout");
            return { proceed };
          },
        },
      });
    },
    { key: DESKTOP_BRIDGE_KEY, proceed },
  );
}

const bridgeCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __bridgeCalls: string[] }).__bridgeCalls);

test.describe("未登入", () => {
  test.use({ mock: { session: "unauthorized" } });

  test("頁面標題是產品名稱", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveTitle(NAMES.productName);
  });

  test("進入看板會被導向登入頁", async ({ page }) => {
    await page.goto("/board");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("link", { name: "使用 GitHub 登入" })).toBeVisible();
  });

  test("進入首頁也會被導向登入頁", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("登入頁的按鈕導向 GitHub 登入端點", async ({ page }) => {
    await page.goto("/login");
    const button = page.getByRole("link", { name: "使用 GitHub 登入" });
    await expect(button).toHaveAttribute("href", "/api/auth/github/login");
    await button.click();
    await expect(page).toHaveURL(/\/api\/auth\/github\/login$/);
  });
});

test("已登入時首頁導向看板，看到所有狀態欄位", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/board$/);
  await expect(page.getByText("octocat", { exact: true })).toBeVisible();

  const columns = page.locator(".board-column");
  await expect(columns).toHaveCount(TASK_STATUSES.length);
  for (const [index, status] of TASK_STATUSES.entries()) {
    await expect(columns.nth(index)).toHaveAttribute("data-status", status);
    await expect(columns.nth(index).getByRole("heading")).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: /^Plan Gate/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^PR Open/ })).toBeVisible();
});

test.describe("還不是任何 Team 的 Member", () => {
  test.use({ mock: { session: "no-team" } });

  test("顯示「尚未加入 Team」", async ({ page }) => {
    await page.goto("/board");
    await expect(page.getByRole("heading", { name: "尚未加入 Team" })).toBeVisible();
    await expect(page.locator(".board-column")).toHaveCount(0);
  });
});

test.describe("登入狀態取得失敗", () => {
  test.use({ mock: { session: "error" } });

  test("非 401 時顯示錯誤，不導向登入頁", async ({ page }) => {
    await page.goto("/board");
    await expect(page.getByRole("heading", { name: "無法取得登入狀態" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveURL(/\/board$/);
  });
});

test.describe("登出", () => {
  test("一般瀏覽器中直接登出，回到登入頁", async ({ page }) => {
    await page.goto("/board");
    await page.getByRole("button", { name: "登出" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/board");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("Desktop 中先呼叫 beforeLogout()，放行後才登出", async ({ page }) => {
    await installBridge(page, true);
    await page.goto("/board");
    await page.getByRole("button", { name: "登出" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await bridgeCalls(page)).toEqual(["beforeLogout"]);
  });

  test("Desktop 中使用者取消（proceed: false）時不登出", async ({ page }) => {
    await installBridge(page, false);
    await page.goto("/board");
    await page.getByRole("button", { name: "登出" }).click();
    await expect.poll(() => bridgeCalls(page)).toEqual(["beforeLogout"]);
    await expect(page).toHaveURL(/\/board/);
    await page.reload();
    await expect(page.getByRole("button", { name: "登出" })).toBeVisible();
  });
});
