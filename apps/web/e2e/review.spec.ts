import type { Page } from "@playwright/test";
import type { MockState } from "../src/mocks/backend";
import { expect, mockState, stream, test } from "./fixtures";

/** 從待我處理打開 ORB-4（等待審查關卡）的差異分頁。 */
async function openReview(page: Page) {
  await page.goto("/needs-you");
  await page
    .locator(".ny-row")
    .filter({ hasText: "ORB-4" })
    .getByRole("button", { name: "前往差異審查" })
    .click();
  await expect(page.getByRole("tab", { name: /差異/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".rp-file")).toBeVisible();
}

const fileTab = (page: Page, name: string) =>
  page.locator(".rp-file-tabs").getByRole("button", { name: new RegExp(name.replace(".", "\\.")) });
/** 點某一側的第 `n` 行（刪除的行在修改前，其他在修改後）。 */
const line = (page: Page, side: "修改前" | "修改後", n: number) =>
  page.getByRole("button", { name: `對${side}第 ${n} 行留言`, exact: true });
const fileComments = (page: Page) => page.locator(".rp-file .rp-comment");
const runIdOf = (page: Page) => new URL(page.url()).searchParams.get("run") ?? "";

test.describe("差異分頁", () => {
  test("依檔案切換 diff", async ({ page }) => {
    await openReview(page);
    await expect(page.locator(".rp-file-tab")).toHaveCount(3);
    await expect(page.locator(".rp-file")).toHaveAttribute("data-path", "config.json");
    await fileTab(page, "README.md").click();
    await expect(page.locator(".rp-file")).toHaveAttribute("data-path", "README.md");
    await expect(page.locator(".rp-file")).toContainText("已由 Fake Agent 更新。");
    await expect(page.locator(".rp-file-head")).toContainText("修改");
    await expect(fileTab(page, "hello.txt").locator(".rp-file-letter")).toHaveText("A");
  });

  test("點一行加入留言，草稿重新整理後仍在，可以刪除", async ({ page }) => {
    await openReview(page);
    await fileTab(page, "README.md").click();

    await line(page, "修改後", 3).click();
    await page
      .getByRole("combobox", { name: "對修改後第 3 行留言" })
      .fill("這句話請說明更新了什麼");
    await page.getByRole("button", { name: "加入留言" }).click();

    // 上下文行（兩側都有）的留言放在修改後
    await line(page, "修改後", 1).click();
    await page.getByRole("combobox", { name: "對修改後第 1 行留言" }).fill("標題保留");
    await page.getByRole("button", { name: "加入留言" }).click();

    await expect(fileComments(page)).toHaveCount(2);
    await expect(fileComments(page).nth(0)).toContainText("修改後第 1 行");
    await expect(fileComments(page).nth(1)).toContainText("修改後第 3 行");
    await expect(fileTab(page, "README.md").locator(".rp-file-dot")).toBeVisible();
    await expect(page.locator(".rp-diff-bar")).toContainText("2 則留言");

    await page.reload();
    await fileTab(page, "README.md").click();
    await expect(fileComments(page)).toHaveCount(2);
    await fileComments(page).nth(0).getByRole("button", { name: "刪除" }).click();
    await expect(fileComments(page)).toHaveCount(1);
  });

  test("退回並附上留言：送出打包的留言，Run 回到執行並再次進入審查關卡", async ({ page }) => {
    await openReview(page);
    const reject = page.getByRole("button", { name: /^退回（/ });
    await expect(reject).toBeDisabled();

    await fileTab(page, "hello.txt").click();
    await line(page, "修改後", 1).click();
    await page.getByRole("combobox", { name: "對修改後第 1 行留言" }).fill("結尾不要換行");
    await page.getByRole("button", { name: "加入留言" }).click();
    await page.getByLabel("整體說明（選填）").fill("請修正後再送");
    await expect(reject).toHaveText("退回（1）");
    await reject.click();

    const runId = runIdOf(page);
    await expect
      .poll(async () => (await mockState<MockState>(page)).reviews[runId])
      .toEqual([
        {
          action: "reject",
          comment: "請修正後再送",
          reviewComments: [{ path: "hello.txt", line: 1, side: "new", body: "結尾不要換行" }],
          // W5–7 契約新增，契約的 schema 補上預設值
          previewComments: [],
        },
      ]);
    await expect(stream(page)).toContainText("收到 review 留言");
    await expect(page.getByTestId("run-status")).toHaveText("等待審查關卡");
  });

  test("在輸入框送出也是退回：文字當成整體說明", async ({ page }) => {
    await openReview(page);
    const composer = page.getByRole("textbox", { name: "整體說明，送出即退回並附上留言" });
    await composer.fill("README 再補一段");
    await composer.press("Enter");
    const runId = runIdOf(page);
    await expect
      .poll(async () => (await mockState<MockState>(page)).reviews[runId])
      .toEqual([
        { action: "reject", comment: "README 再補一段", reviewComments: [], previewComments: [] },
      ]);
  });

  test("核准後 Run 完成、Task 進入合併請求已開啟", async ({ page }) => {
    await openReview(page);
    await page.getByRole("button", { name: "核准並開啟合併請求" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("已完成");
    await expect(page.locator(".rp-diff-mode")).toHaveText("唯讀");
    await page.getByRole("tab", { name: /任務/ }).click();
    await expect(page.locator(".rp-status")).toHaveText("合併請求已開啟");
  });

  test.describe("禁止核准自己的 Task（Member）", () => {
    test.use({ mock: { role: "member", policy: { forbidSelfApproval: true } } });

    test("指派給自己時不顯示核准，但可以退回", async ({ page }) => {
      // ORB-4 指派給 alice；先改成指派給自己
      await page.goto("/tasks/ORB-4");
      await page.getByRole("button", { name: "指派對象" }).click();
      await page.getByRole("menuitemradio", { name: /@octocat/ }).click();
      await expect(page.getByRole("button", { name: "指派對象" })).toContainText("@octocat");
      await page.getByRole("tab", { name: /差異/ }).click();
      await expect(page.getByRole("button", { name: /^退回（/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "核准並開啟合併請求" })).toHaveCount(0);
    });
  });

  test.describe("禁止核准自己的 Task（Owner）", () => {
    test.use({ mock: { policy: { forbidSelfApproval: true } } });

    test("只限制 Member，Owner 指派給自己仍可以核准", async ({ page }) => {
      await page.goto("/tasks/ORB-4");
      await page.getByRole("button", { name: "指派對象" }).click();
      await page.getByRole("menuitemradio", { name: /@octocat/ }).click();
      await expect(page.getByRole("button", { name: "指派對象" })).toContainText("@octocat");
      await page.getByRole("tab", { name: /差異/ }).click();
      await expect(page.getByRole("button", { name: "核准並開啟合併請求" })).toBeVisible();
    });
  });

  test("在審查關卡中止：以 Gate 的 abort 送出，Task 回到就緒", async ({ page }) => {
    await openReview(page);
    await page.getByRole("button", { name: "中止執行" }).click();
    const runId = runIdOf(page);
    await expect(page.getByTestId("run-status")).toHaveText("已中止");
    const state = await mockState<MockState>(page);
    expect(state.reviews[runId]).toEqual([{ action: "abort" }]);
    await page.getByRole("tab", { name: /任務/ }).click();
    await expect(page.locator(".rp-status")).toHaveText("就緒");
  });

  test("深連結 /runs/:id/review 開啟同一個工作區的差異分頁", async ({ page }) => {
    await openReview(page);
    const runId = runIdOf(page);
    await page.goto(`/runs/${runId}/review`);
    await expect(page.getByRole("tab", { name: /差異/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".wk-header-key")).toHaveText("ORB-4");
  });

  test.describe("大檔與二進位檔案", () => {
    test.use({ mock: { blobDiff: true } });

    test("放在 blob 的內容向 Server 取得後顯示；二進位檔案只顯示有變更", async ({ page }) => {
      await openReview(page);
      await fileTab(page, "README.md").click();
      await expect(page.locator(".rp-file")).toContainText("已由 Fake Agent 更新");

      await fileTab(page, "logo.png").click();
      await expect(page.getByText("二進位檔案，無法檢視內容")).toBeVisible();
      await expect(page.locator(".rp-line")).toHaveCount(0);
    });
  });
});
