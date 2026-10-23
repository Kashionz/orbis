// Repo Spec 草稿（#40）：在 Project 設定頁登記，草稿頁共同編輯，「提交到 repo」後顯示 PR 連結。

import { expect, test } from "./fixtures";

test("從 Project 設定頁進入 Spec 草稿，提交到 repo 後顯示 PR 連結；再次提交時更新同一個 PR", async ({
  page,
}) => {
  await page.goto("/projects/project-1/settings");
  const specs = page.locator('.repo-specs[data-repo="acme/demo"]');
  await expect(specs).toContainText("docs/specs/login.md");
  await specs.getByRole("link", { name: "登入" }).click();
  await expect(page).toHaveURL(/\/repo-specs\/spec-1$/);
  await expect(page.locator(".page-header h1")).toHaveText("登入");
  const editor = page.getByRole("textbox", { name: "Spec 草稿" });
  await expect(editor).toContainText("使用 GitHub 帳號登入。");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("也支援 SSO。");

  const form = page.getByRole("form", { name: "提交到 repo" });
  await form.getByLabel("commit 訊息（選填）").fill("docs: 登入 Spec 加上 SSO");
  await form.getByRole("button", { name: "提交到 repo" }).click();
  const status = page.getByRole("status");
  await expect(status).toContainText("已開 PR：");
  await expect(status.getByRole("link", { name: "#40" })).toHaveAttribute(
    "href",
    "https://github.com/acme/demo/pull/40",
  );

  await form.getByRole("button", { name: "提交到 repo" }).click();
  await expect(status).toContainText("已更新 PR：");
});

test.describe("default branch 上的檔案被改過", () => {
  test.use({ mock: { eventIntervalMs: 20, specUpstreamChanged: true } });

  test("提交後警告會覆蓋別人的修改", async ({ page }) => {
    await page.goto("/repo-specs/spec-1");
    await page.getByRole("button", { name: "提交到 repo" }).click();
    await expect(page.getByRole("alert")).toContainText("這個 PR 會覆蓋那些修改");
  });
});

test("登記新的 Spec：路徑要是 repo 內的 .md 檔", async ({ page }) => {
  await page.goto("/projects/project-1/settings");
  const form = page.getByRole("form", { name: "登記 acme/demo 的 Spec" });
  await form.getByLabel("Spec 路徑").fill(".github/spec.md");
  await form.getByRole("button", { name: "登記 Spec" }).click();
  await expect(form.getByLabel("Spec 路徑")).toHaveAttribute("aria-invalid", "true");
  await form.getByLabel("Spec 路徑").fill("docs/specs/billing.md");
  await form.getByLabel("標題（選填）").fill("帳單");
  await form.getByRole("button", { name: "登記 Spec" }).click();
  await expect(page.locator('.repo-specs[data-repo="acme/demo"]')).toContainText(
    "docs/specs/billing.md",
  );
  await page.getByRole("link", { name: "帳單" }).click();
  await expect(page.locator(".page-header h1")).toHaveText("帳單");
  await expect(page.getByText("第 0 版")).toBeVisible();
});

test("Task 頁的 Spec 欄位連到草稿頁", async ({ page }) => {
  await page.goto("/tasks/ORB-1");
  await page.getByRole("link", { name: "docs/specs/login.md" }).click();
  await expect(page).toHaveURL(/\/repo-specs\/spec-1$/);
});

test.describe("Viewer", () => {
  test.use({ mock: { eventIntervalMs: 20, role: "viewer" } });

  test("可以看草稿，但不能提交或登記", async ({ page }) => {
    await page.goto("/repo-specs/spec-1");
    await expect(page.getByRole("textbox", { name: "Spec 草稿" })).toHaveAttribute(
      "contenteditable",
      "false",
    );
    await expect(page.getByRole("form", { name: "提交到 repo" })).toHaveCount(0);
  });
});
