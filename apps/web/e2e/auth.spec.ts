import { type MeResponse, NAMES, TASK_STATUSES } from "@orbis/api-contract";
import { expect, type Page, test } from "@playwright/test";

const ME_URL = "**/api/auth/me";

const member: MeResponse = {
  githubUserId: 583231,
  githubLogin: "octocat",
  name: "The Octocat",
  avatarUrl: null,
  member: { id: "m1", teamId: "t1", teamName: "核心團隊", role: "owner" },
};

async function mockMe(page: Page, status: number, body?: MeResponse) {
  await page.route(ME_URL, (route) =>
    route.fulfill({ status, json: body ?? { error: "unauthorized" } }),
  );
}

test("頁面標題是產品名稱", async ({ page }) => {
  await mockMe(page, 401);
  await page.goto("/login");
  await expect(page).toHaveTitle(NAMES.productName);
});

test("未登入時進入看板會被導向登入頁", async ({ page }) => {
  await mockMe(page, 401);
  await page.goto("/board");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("link", { name: "使用 GitHub 登入" })).toBeVisible();
});

test("未登入時進入首頁也會被導向登入頁", async ({ page }) => {
  await mockMe(page, 401);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

test("登入頁的按鈕導向 GitHub 登入端點", async ({ page }) => {
  await page.route("**/api/auth/github/login", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<p>github</p>" }),
  );
  await page.goto("/login");
  const button = page.getByRole("link", { name: "使用 GitHub 登入" });
  await expect(button).toHaveAttribute("href", "/api/auth/github/login");
  await button.click();
  await expect(page).toHaveURL(/\/api\/auth\/github\/login$/);
});

test("已登入時首頁導向看板，看到空看板與所有狀態欄位", async ({ page }) => {
  await mockMe(page, 200, member);
  await page.goto("/");
  await expect(page).toHaveURL(/\/board$/);
  await expect(page.getByText(member.githubLogin)).toBeVisible();

  const columns = page.locator("[data-status]");
  await expect(columns).toHaveCount(TASK_STATUSES.length);
  for (const [index, status] of TASK_STATUSES.entries()) {
    const column = columns.nth(index);
    await expect(column).toHaveAttribute("data-status", status);
    await expect(column.getByRole("heading")).toBeVisible();
    await expect(column.getByText("沒有 Task")).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Plan Gate" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "PR Open" })).toBeVisible();
});

test("還不是任何 Team 的 Member 時顯示「尚未加入 Team」", async ({ page }) => {
  await mockMe(page, 200, { ...member, member: null });
  await page.goto("/board");
  await expect(page.getByRole("heading", { name: "尚未加入 Team" })).toBeVisible();
  await expect(page.locator("[data-status]")).toHaveCount(0);
});

test("取得登入狀態失敗（非 401）時顯示錯誤，不導向登入頁", async ({ page }) => {
  await mockMe(page, 500);
  await page.goto("/board");
  await expect(page.getByRole("heading", { name: "無法取得登入狀態" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page).toHaveURL(/\/board$/);
});
