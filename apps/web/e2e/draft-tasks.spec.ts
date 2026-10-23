// Draft Task 審核（#44）：逐筆或批次確認、修改、捨棄 Agent 提出的 Task。

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const draft = (page: Page, position: number) =>
  page.locator(`.draft-task[data-position="${position}"]`);

test("從看板進入，依批次列出 Draft Task、Acceptance Criterion 與相依關係", async ({ page }) => {
  await page.goto("/board");
  await expect(page.getByTestId("draft-task-count")).toContainText("3");
  await page.getByRole("link", { name: /Draft Task/ }).click();
  await expect(page).toHaveURL(/\/projects\/project-1\/draft-tasks$/);
  await expect(page.locator(".draft-task")).toHaveCount(3);
  await expect(draft(page, 1)).toContainText("建立登入 API");
  await expect(draft(page, 1).getByRole("list", { name: "Acceptance Criterion" })).toContainText(
    "pnpm test",
  );
  await expect(draft(page, 2).locator('[data-dependency="#1"]')).toHaveText("#1 建立登入 API");
  await expect(draft(page, 3).locator('[data-dependency="ORB-1"]')).toHaveAttribute(
    "href",
    "/tasks/ORB-1",
  );
  await expect(page.locator(".draft-batch-header")).toContainText("docs/specs/login.md");
});

test("依賴的草稿還沒確認時不能確認；確認後同一批的 #n 改成 Task Key", async ({ page }) => {
  await page.goto("/projects/project-1/draft-tasks");
  await draft(page, 2).getByRole("button", { name: "確認" }).click();
  await expect(draft(page, 2).getByRole("alert")).toContainText("依賴的 Draft Task #1 還沒確認");

  await draft(page, 1).getByRole("button", { name: "確認" }).click();
  await expect(draft(page, 1)).toHaveCount(0);
  const status = page.getByRole("status");
  await expect(status).toContainText("ORB-8 建立登入 API");
  await expect(draft(page, 2).locator('[data-dependency="ORB-8"]')).toBeVisible();

  await status.getByRole("link", { name: /ORB-8/ }).click();
  await expect(page.locator(".page-header .status-badge")).toHaveText("Backlog");
  await expect(page.locator(".ac-list > li")).toHaveCount(2);
});

test("批次確認依相依順序建立；捨棄時移除同一批指向它的相依", async ({ page }) => {
  await page.goto("/projects/project-1/draft-tasks");
  // 捨棄 #1：#2 對 #1 的相依被移除
  await draft(page, 1).getByRole("button", { name: "捨棄" }).click();
  await expect(draft(page, 1)).toHaveCount(0);
  await expect(draft(page, 2).locator(".draft-depends")).toHaveCount(0);

  await page.getByLabel("全選這一批").check();
  await page.getByRole("button", { name: "確認選取的（2）" }).click();
  await expect(page.locator(".draft-task")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("ORB-8 登入頁 UI");
  await expect(page.getByRole("status")).toContainText("ORB-9 登入流程的 e2e");
});

test("修改 Draft Task：標題、Acceptance Criterion 與相依；格式不對時列出問題", async ({ page }) => {
  await page.goto("/projects/project-1/draft-tasks");
  await draft(page, 3).getByRole("button", { name: "修改" }).click();
  const form = page.getByRole("form", { name: "修改 #3" });
  await form.getByLabel("標題").fill("登入流程的 e2e（Playwright）");
  await form.getByLabel("依賴").fill("#2, orb-1");
  await form.getByRole("button", { name: "儲存" }).click();
  await expect(form.getByRole("alert")).toContainText("依賴必須是 #<n> 或 Task Key");

  await form.getByLabel("依賴").fill("#2");
  await form.getByRole("button", { name: "新增一條" }).click();
  await form.getByLabel("第 2 條的條件").fill("畫面截圖正確");
  await form.getByRole("button", { name: "儲存" }).click();
  await expect(form).toHaveCount(0);
  await expect(draft(page, 3)).toContainText("登入流程的 e2e（Playwright）");
  await expect(draft(page, 3).getByRole("list", { name: "Acceptance Criterion" })).toContainText(
    "畫面截圖正確",
  );
  await expect(draft(page, 3).locator('[data-dependency="ORB-1"]')).toHaveCount(0);
});

test.describe("Viewer", () => {
  test.use({ mock: { role: "viewer" } });

  test("只能查看，不能確認、修改或捨棄", async ({ page }) => {
    await page.goto("/projects/project-1/draft-tasks");
    await expect(page.locator(".draft-task")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "確認" })).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
  });
});
