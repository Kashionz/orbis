// 從 UI 建立 Project 與登記 Repo，跑在完整系統上（真實 Server + Postgres + FakeGitHub）。
// 系統由 globalSetup 啟動（見 playwright.system.config.ts）；種子 Repo 已安裝 GitHub App。

import { expect, test } from "@playwright/test";
import { readStack } from "./stack";

const stack = readStack();

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ ...stack.sessionCookie, url: baseURL ?? "" }]);
});

test("從 UI 建立 Project、登記 Repo：前綴重複時顯示 409，App 未安裝時顯示安裝連結", async ({
  page,
}) => {
  // 種子 Project 的 Repo：App 已安裝
  await page.goto(`/projects/${stack.projectId}/settings`);
  await expect(page.locator("tr[data-repo]")).toHaveCount(1);
  await expect(page.locator("tr[data-repo] td[data-installed]")).toHaveText("已安裝");

  await page.goto("/board");
  await page.getByRole("button", { name: /^專案 / }).click();
  await page.getByRole("menu", { name: "專案" }).getByText("新增專案").click();
  const dialog = page.getByRole("dialog", { name: "新增專案" });
  await dialog.getByLabel("名稱").fill("從 UI 建立的 Project");
  await dialog.getByLabel("任務編號前綴").fill(stack.projectKey);
  await dialog.getByRole("button", { name: "建立" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(`Task Key 前綴 ${stack.projectKey} 已被使用`);

  // Task Key 前綴在 Team 內唯一；每次啟動的 stack 都是新的 Team
  const prefix = "WEB";
  await dialog.getByLabel("任務編號前綴").fill(prefix);
  await dialog.getByRole("button", { name: "建立" }).click();
  await expect(dialog).toBeHidden();
  const projectMenu = page.getByRole("button", { name: /^專案 / });
  await expect(projectMenu).toHaveAccessibleName("專案 從 UI 建立的 Project");

  await projectMenu.click();
  await page.getByRole("menu", { name: "專案" }).getByText("專案設定").click();
  await expect(page.getByText("還沒有登記任何儲存庫。")).toBeVisible();
  const form = page.getByRole("form", { name: "登記儲存庫" });
  await form.getByLabel("帳號或組織").fill("octocat");
  await form.getByLabel("儲存庫名稱").fill("tools");
  await form.getByRole("button", { name: "登記" }).click();

  const row = page.locator('tr[data-repo="octocat/tools"]');
  await expect(row).toContainText("main");
  await expect(row.locator("td[data-installed]")).toContainText("未安裝");
  await expect(row.getByRole("link", { name: "安裝 GitHub App" })).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\/apps\/[^/]+\/installations\/new$/,
  );

  await form.getByLabel("帳號或組織").fill("octocat");
  await form.getByLabel("儲存庫名稱").fill("tools");
  await form.getByRole("button", { name: "登記" }).click();
  await expect(form.getByRole("alert")).toHaveText("octocat/tools 已經登記在這個 Project");
});
