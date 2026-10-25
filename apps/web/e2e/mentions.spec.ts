// @mention（#43）：Task 留言與 diff 行內留言中輸入 @ 自動完成成員與 Agent；@agent 建立 consult Run。

import { expect, test } from "./fixtures";

test("Task 留言 @agent：自動完成、送出後顯示 consult Run 的連結，Agent 的回覆貼回留言", async ({
  page,
}) => {
  await page.goto("/tasks/ORB-2");
  const input = page.getByRole("combobox", { name: "留言內容" });
  await input.fill("請 @cla");
  const options = page.getByRole("listbox", { name: "提及的對象" }).getByRole("option");
  await expect(options).toHaveText(["@claude Agent（claude-code）"]);
  await input.press("Enter");
  await expect(input).toHaveValue("請 @[claude](agent:claude-code) ");
  await input.pressSequentially("幫我看 README");
  await page.getByRole("button", { name: "送出留言" }).click();

  const comment = page.locator(".task-comment").first();
  await expect(comment.locator(".mention")).toHaveText("@claude");
  await expect(comment).toContainText("幫我看 README");
  const consult = comment.getByRole("link", { name: /@agent 的諮詢執行/ });
  await expect(consult).toBeVisible();
  // consult Run 出現在執行紀錄，結束後回覆貼回成留言
  await expect(page.locator(".rp-run").first()).toContainText("@agent");
  await expect(page.locator(".task-comment")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator(".task-comment").nth(1)).toContainText("代理的回覆");
  await expect(page.locator(".task-comment").nth(1)).toContainText("README 可以再補上使用範例");

  await consult.click();
  await expect(page.getByTestId("run-origin")).toContainText("@agent");
});

test("@成員：以方向鍵選擇，顯示成標籤；可以修改與刪除自己的留言", async ({ page }) => {
  await page.goto("/tasks/ORB-2");
  const input = page.getByRole("combobox", { name: "留言內容" });
  await input.fill("@");
  const listbox = page.getByRole("listbox", { name: "提及的對象" });
  await expect(listbox.getByRole("option")).toHaveCount(5);
  await input.fill("@b");
  await expect(listbox.getByRole("option")).toHaveText(["@bob Bob"]);
  await input.fill("@al");
  await input.press("ArrowDown");
  await input.press("Enter");
  await input.pressSequentially("請確認");
  await page.getByRole("button", { name: "送出留言" }).click();

  const comment = page.locator(".task-comment").first();
  await expect(comment.locator(".mention")).toHaveText("@alice");
  await expect(comment.getByRole("link", { name: /諮詢執行/ })).toHaveCount(0);

  await comment.getByRole("button", { name: "修改" }).click();
  await comment.getByRole("combobox", { name: "修改留言" }).fill("改過的留言");
  await comment.getByRole("button", { name: "儲存" }).click();
  await expect(comment).toContainText("改過的留言");
  await expect(comment).toContainText("（已編輯）");
  await comment.getByRole("button", { name: "刪除" }).click();
  await expect(page.locator(".task-comment")).toHaveCount(0);
});

test("diff 行內留言 @agent：退回後在之前的退回中顯示 consult Run", async ({ page }) => {
  await page.goto("/tasks/ORB-4");
  await page.getByRole("tab", { name: /差異/ }).click();
  await page
    .locator(".rp-file-tabs")
    .getByRole("button", { name: /README\.md/ })
    .click();
  await page.getByRole("button", { name: "對修改後第 1 行留言", exact: true }).click();
  const input = page.getByRole("combobox", { name: "對修改後第 1 行留言" });
  await input.fill("@codex");
  await input.press("Enter");
  await input.pressSequentially("這裡的寫法對嗎？");
  await page.getByRole("button", { name: "加入留言" }).click();
  await expect(page.locator(".rp-file .rp-comment .mention")).toHaveText("@codex");
  await page.getByRole("button", { name: /^退回（/ }).click();

  await expect(page.getByTestId("timeline")).toContainText("已依照留言修改。");
  await expect(page.getByTestId("run-status")).toHaveText("等待審查關卡");
  const previous = page.locator(".rp-diff-section").filter({ hasText: "之前的退回" });
  await previous.getByRole("button", { name: /之前的退回/ }).click();
  await expect(previous.locator(".mention")).toHaveText("@codex");
  await expect(previous.getByRole("link", { name: /@agent 的諮詢執行/ })).toBeVisible();
});
