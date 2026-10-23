import type { Page } from "@playwright/test";
import type { MockState } from "../src/mocks/backend";
import { expect, mockState, test } from "./fixtures";

/** 打開 ORB-4（等待 Review Gate）的 diff review。 */
async function openReview(page: Page) {
  await page.goto("/needs-you");
  await page.getByRole("link", { name: "前往 diff review" }).click();
  await expect(page.getByTestId("diff-editor")).toBeVisible();
}

/** 點 Monaco 中某一側的第 `line` 個行號。 */
async function clickLineNumber(page: Page, side: "original" | "modified", line: number) {
  await page
    .locator(`.editor.${side} .line-numbers`)
    .filter({ hasText: new RegExp(`^${line}$`) })
    .click();
}

const fileButton = (page: Page, path: string) =>
  page.locator(".file-list").getByRole("button", { name: new RegExp(path.replace(".", "\\.")) });

test.describe("Diff review", () => {
  test("依檔案切換 diff", async ({ page }) => {
    await openReview(page);
    await expect(page.locator(".file-list button")).toHaveCount(3);
    await expect(page.getByTestId("diff-editor")).toHaveAttribute("data-path", "config.json");
    await fileButton(page, "README.md").click();
    await expect(page.getByTestId("diff-editor")).toHaveAttribute("data-path", "README.md");
    await expect(page.locator(".editor.modified .view-lines")).toContainText(
      "已由 Fake Agent 更新。",
    );
    await expect(fileButton(page, "README.md")).toContainText("修改");
    await expect(fileButton(page, "hello.txt")).toContainText("新增");
  });

  test("點行號在任一行加入留言，草稿重新整理後仍在，可以刪除", async ({ page }) => {
    await openReview(page);
    await fileButton(page, "README.md").click();

    await clickLineNumber(page, "modified", 3);
    await expect(page.getByLabel("行號")).toHaveValue("3");
    await expect(page.getByLabel("留言在哪一側")).toHaveValue("new");
    await page.getByLabel("留言內容").fill("這句話請說明更新了什麼");
    await page.getByRole("button", { name: "加入留言" }).click();

    await clickLineNumber(page, "original", 1);
    await expect(page.getByLabel("留言在哪一側")).toHaveValue("old");
    await page.getByLabel("留言內容").fill("標題保留");
    await page.getByRole("button", { name: "加入留言" }).click();

    const comments = page.getByRole("list", { name: "這個檔案的留言" }).getByRole("listitem");
    await expect(comments).toHaveCount(2);
    await expect(comments.nth(0)).toContainText("修改前第 1 行");
    await expect(comments.nth(1)).toContainText("修改後第 3 行");
    await expect(fileButton(page, "README.md")).toContainText("2");

    await page.reload();
    await fileButton(page, "README.md").click();
    await expect(comments).toHaveCount(2);
    await comments.nth(0).getByRole("button", { name: "刪除留言" }).click();
    await expect(comments).toHaveCount(1);
  });

  test("退回並附上留言：送出打包的留言，Run 回到執行並再次進入 Review Gate", async ({ page }) => {
    await openReview(page);
    const reject = page.getByRole("button", { name: /退回並附上留言/ });
    await expect(reject).toBeDisabled();

    await fileButton(page, "hello.txt").click();
    await page.getByLabel("行號").fill("1");
    await page.getByLabel("留言內容").fill("結尾不要換行");
    await page.getByRole("button", { name: "加入留言" }).click();
    await page.getByLabel("整體說明（選填）").fill("請修正後再送");
    await reject.click();

    await expect(page).toHaveURL(/\/runs\/run-\d+$/);
    const runId = page.url().split("/").pop() ?? "";
    const state = await mockState<MockState>(page);
    // 契約的 Gate 決定：退回時連同行內留言一起送出
    expect(state.reviews[runId]).toEqual([
      {
        action: "reject",
        comment: "請修正後再送",
        reviewComments: [{ path: "hello.txt", line: 1, side: "new", body: "結尾不要換行" }],
      },
    ]);
    await expect(page.getByTestId("timeline")).toContainText("收到 review 留言");
    await expect(page.getByTestId("run-status")).toHaveText("等待 Gate");
  });

  test("核准後 Run 完成、Task 進入 PR Open", async ({ page }) => {
    await openReview(page);
    await page.getByRole("button", { name: "核准並開 PR" }).click();
    await expect(page).toHaveURL(/\/runs\/run-\d+$/);
    await expect(page.getByTestId("run-status")).toHaveText("已完成");
    await page.getByRole("link", { name: /ORB-4/ }).click();
    await expect(page.locator(".page-header .status-badge")).toHaveText("PR Open");
  });

  test.describe("禁止核准自己的 Task（Member）", () => {
    test.use({ mock: { role: "member", policy: { forbidSelfApproval: true } } });

    test("指派給自己時不顯示核准，但可以退回", async ({ page }) => {
      // ORB-4 指派給 alice；先改成指派給自己
      await page.goto("/tasks/ORB-4");
      await page.getByLabel("指派對象").selectOption({ label: "@octocat（The Octocat）" });
      await expect(page.getByLabel("指派對象")).toHaveValue("member-me");
      await page.getByRole("link", { name: /^run-/ }).click();
      await page.getByRole("link", { name: "Diff review" }).click();
      await expect(page.getByRole("button", { name: /退回並附上留言/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "核准並開 PR" })).toHaveCount(0);
    });
  });

  test.describe("禁止核准自己的 Task（Owner）", () => {
    test.use({ mock: { policy: { forbidSelfApproval: true } } });

    test("只限制 Member，Owner 指派給自己仍可以核准", async ({ page }) => {
      await page.goto("/tasks/ORB-4");
      await page.getByLabel("指派對象").selectOption({ label: "@octocat（The Octocat）" });
      await expect(page.getByLabel("指派對象")).toHaveValue("member-me");
      await page.getByRole("link", { name: /^run-/ }).click();
      await page.getByRole("link", { name: "Diff review" }).click();
      await expect(page.getByRole("button", { name: "核准並開 PR" })).toBeVisible();
    });
  });

  test("在 Review Gate 中止：以 Gate 的 abort 送出，Task 回到 Ready", async ({ page }) => {
    await openReview(page);
    await page.getByRole("button", { name: "中止 Run" }).click();
    await expect(page).toHaveURL(/\/runs\/run-\d+$/);
    const runId = page.url().split("/").pop() ?? "";
    await expect(page.getByTestId("run-status")).toHaveText("已中止");
    const state = await mockState<MockState>(page);
    expect(state.reviews[runId]).toEqual([{ action: "abort" }]);
    await page.getByRole("link", { name: /ORB-4/ }).click();
    await expect(page.locator(".page-header .status-badge")).toHaveText("Ready");
  });

  test.describe("大檔與二進位檔案", () => {
    test.use({ mock: { blobDiff: true } });

    test("放在 blob 的內容向 Server 取得後顯示；二進位檔案只顯示有變更", async ({ page }) => {
      await openReview(page);
      await fileButton(page, "README.md").click();
      await expect(page.getByTestId("diff-editor")).toContainText("已由 Fake Agent 更新");

      await fileButton(page, "logo.png").click();
      await expect(page.getByText("二進位檔案，只顯示有變更，無法檢視內容。")).toBeVisible();
      await expect(page.getByTestId("diff-editor")).toHaveCount(0);
    });
  });
});
