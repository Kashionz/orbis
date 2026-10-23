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
  const consult = comment.getByRole("link", { name: /@agent 的 consult Run/ });
  await expect(consult).toBeVisible();
  // consult Run 出現在 Run 樹，結束後回覆貼回成留言
  await expect(page.locator(".run-node").first()).toContainText("@agent");
  await expect(page.locator(".task-comment")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator(".task-comment").nth(1)).toContainText("Agent 的回覆");
  await expect(page.locator(".task-comment").nth(1)).toContainText("README 可以再補上使用範例");

  await consult.click();
  await expect(page.locator(".run-meta")).toContainText("@agent");
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
  await expect(comment.getByRole("link", { name: /consult Run/ })).toHaveCount(0);

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
  await page.locator(".run-node").first().getByRole("link", { name: "開啟 Run 頁" }).click();
  await page.getByRole("link", { name: "Diff review" }).click();
  await page
    .locator(".file-list")
    .getByRole("button", { name: /README\.md/ })
    .click();
  await page.getByLabel("行號").fill("1");
  const input = page.getByRole("combobox", { name: "留言內容" });
  await input.fill("@codex");
  await input.press("Enter");
  await input.pressSequentially("這裡的寫法對嗎？");
  await page.getByRole("button", { name: "加入留言" }).click();
  await expect(page.locator(".review-comment .mention")).toHaveText("@codex");
  await page.getByRole("button", { name: /退回並附上留言/ }).click();

  await expect(page.getByTestId("timeline")).toContainText("已依照留言修改。");
  await page.getByRole("link", { name: "Diff review" }).click();
  const previous = page.getByRole("region", { name: "之前的退回" });
  await expect(previous.locator(".mention")).toHaveText("@codex");
  await expect(previous.getByRole("link", { name: /@agent 的 consult Run/ })).toBeVisible();
});
