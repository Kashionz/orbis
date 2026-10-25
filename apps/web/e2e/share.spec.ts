// 分享卡與邀請成功卡（新工作區介面 PROMPTS 第 5i 點）。後端還沒有 Task 層級的分享，mock 提供完整行為；
// 這裡以元件展示頁的 ORB-4 分享區塊測試（工作區標題列由 U2 接上）。

import { expect, test } from "./fixtures";

test("成員角色、撤銷邀請、一般存取；加入成員與 Email 後顯示邀請成功卡", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/__dev/components");
  const share = page.getByRole("region", { name: "share" });
  await share.getByRole("button", { name: "分享" }).click();
  const card = page.getByRole("dialog", { name: "分享「整理 README」" });
  await expect(card.getByRole("textbox", { name: "搜尋成員或輸入 Email" })).toBeFocused();

  // 任務連結
  await expect(card).toContainText("/tasks/ORB-4");
  await card.getByRole("button", { name: "複製" }).click();
  await expect(card.getByRole("button", { name: "已複製" })).toBeVisible();

  // 這個任務中的成員與邀請
  await expect(card.getByText("octocat（你）")).toBeVisible();
  await expect(card.getByText("擁有者")).toBeVisible();
  await card.getByRole("button", { name: "alice 的角色：可操作" }).click();
  await page.getByRole("menuitemradio", { name: /可檢視/ }).click();
  await expect(card.getByRole("button", { name: "alice 的角色：可檢視" })).toBeVisible();
  await card.getByRole("button", { name: "撤銷" }).click();
  await expect(card.getByText("ops@example.com")).toHaveCount(0);

  // 一般存取
  await card.getByRole("button", { name: /^一般存取/ }).click();
  await page.getByRole("menuitemradio", { name: /僅受邀成員/ }).click();
  await expect(card.getByRole("button", { name: /^一般存取/ })).toContainText(
    "只有擁有者與受邀成員",
  );

  // 加入成員：選 bob，再輸入 Email 按 Enter
  const submit = card.getByRole("button", { name: /^加入任務/ });
  await expect(submit).toBeDisabled();
  await card.getByRole("button", { name: "bob" }).click();
  await expect(card.getByRole("button", { name: "bob" })).toHaveAttribute("aria-pressed", "true");
  const search = card.getByRole("textbox", { name: "搜尋成員或輸入 Email" });
  await search.fill("new@example.com");
  await search.press("Enter");
  await expect(search).toHaveValue("");
  await expect(submit).toHaveText("加入任務（2）");
  await submit.click();

  const done = page.getByRole("alertdialog", { name: "已邀請 2 位成員" });
  await expect(done).toContainText("加入「整理 README」");
  await expect(done).toContainText("new@example.com");
  await expect(done).toContainText("Email 邀請");
  await expect(done.getByRole("button", { name: "完成" })).toBeFocused();
  await done.getByRole("button", { name: "繼續邀請" }).click();
  await expect(card).toBeVisible();
  await expect(card.getByText("bob")).toBeVisible();
  await expect(card.getByText("new@example.com")).toBeVisible();
});

test("搜尋有字時 Esc 先清除搜尋，再按一次才關閉；點外面關閉", async ({ page }) => {
  await page.goto("/__dev/components");
  const button = page.getByRole("region", { name: "share" }).getByRole("button", { name: "分享" });
  await button.click();
  const card = page.getByRole("dialog", { name: /^分享/ });
  const search = card.getByRole("textbox", { name: "搜尋成員或輸入 Email" });
  await search.fill("bo");
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(card).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(button).toBeFocused();

  await button.click();
  await page.mouse.click(10, 10);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("標題列變窄時隱藏頭像，再窄時分享按鈕只剩圖示", async ({ page }) => {
  await page.goto("/__dev/components");
  const share = page.getByRole("region", { name: "share" });
  await expect(share.locator(".share-faces")).toBeVisible();
  await share.getByRole("combobox", { name: "標題列寬度" }).selectOption("600");
  await expect(share.locator(".share-faces")).toHaveCount(0);
  await expect(share.getByRole("button", { name: "分享" })).toHaveText("分享");
  await share.getByRole("combobox", { name: "標題列寬度" }).selectOption("400");
  await expect(share.getByRole("button", { name: "分享" })).toHaveText("");
});

test.describe("後端還沒有分享", () => {
  test.use({ mock: { features: { taskSharing: false } } });

  test("分享按鈕停用並顯示尚未開放", async ({ page }) => {
    await page.goto("/__dev/components");
    const button = page.getByRole("region", { name: "share" }).getByRole("button", {
      name: "分享",
    });
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await button.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.mouse.move(0, 0);
    await button.hover();
    await expect(page.getByRole("tooltip")).toHaveText("尚未開放");
  });
});
