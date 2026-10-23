// Run 頁的 Preview 分頁（E 軌的 PreviewPanel）與 Review 頁的 Preview 留言：退回時和行內留言一起送出。

import type { GateDecisionInput } from "@orbis/api-contract";
import type { Page } from "@playwright/test";
import { expect, mockState, test } from "./fixtures";

/** 1×1 的 PNG。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** 打開 ORB-4（等待 Review Gate）的 Run 頁。 */
async function openReviewRun(page: Page): Promise<string> {
  await page.goto("/tasks/ORB-4");
  await page.locator(".run-node").first().getByRole("link", { name: "開啟 Run 頁" }).click();
  await expect(page).toHaveURL(/\/runs\/run-\d+$/);
  return page.url().split("/").pop() ?? "";
}

test("沒有設定 Preview 時顯示說明", async ({ page }) => {
  await openReviewRun(page);
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.getByText("這個 Repo 沒有設定 Preview")).toBeVisible();
});

test.describe("Preview 已就緒", () => {
  test.use({ mock: { eventIntervalMs: 20, preview: true } });

  test.beforeEach(async ({ page }) => {
    // 測試環境不能用 getDisplayMedia 截圖，改走貼上或上傳圖片的後備
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { value: undefined });
    });
  });

  test("在 Preview 分頁留言成草稿，Review 頁列出並在退回時一起送出", async ({ page }) => {
    const runId = await openReviewRun(page);
    await page.getByRole("tab", { name: "Preview" }).click();
    await expect(page.locator('iframe[title="Preview"]')).toHaveAttribute(
      "src",
      "http://127.0.0.1:9/",
    );
    await page.getByRole("button", { name: "附上整頁截圖留言" }).click();
    await page
      .getByLabel("選擇截圖")
      .setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
    const form = page.getByRole("form", { name: "Preview 留言" });
    await form.getByLabel("留言內容").fill("按鈕太小");
    await form.getByRole("button", { name: "加入 Review 留言草稿" }).click();
    await expect(page.getByRole("region", { name: "Preview 留言草稿" })).toContainText("按鈕太小");

    // Review 頁：只有 Preview 留言也可以退回
    await page.getByRole("link", { name: "Diff review" }).click();
    const drafts = page.getByRole("region", { name: "Preview 留言（1）" });
    await expect(drafts).toContainText("按鈕太小");
    await expect
      .poll(() => drafts.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "退回並附上留言（1）" }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));

    const state = await mockState<{ reviews: Record<string, GateDecisionInput[]> }>(page);
    const sent = state.reviews[runId]?.at(-1);
    expect(sent).toMatchObject({
      action: "reject",
      previewComments: [{ body: "按鈕太小", selector: null }],
    });
    expect(sent?.action === "reject" && sent.previewComments?.[0]?.screenshotBlobId).toBeTruthy();

    // 送出後草稿清空
    await page.getByRole("tab", { name: "Preview" }).click();
    await expect(page.getByRole("region", { name: "Preview 留言草稿" })).toHaveCount(0);
  });

  test("Review 頁可以刪除 Preview 留言草稿", async ({ page }) => {
    await openReviewRun(page);
    await page.getByRole("tab", { name: "Preview" }).click();
    await page.getByRole("button", { name: "附上整頁截圖留言" }).click();
    await page
      .getByLabel("選擇截圖")
      .setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("form", { name: "Preview 留言" }).getByLabel("留言內容").fill("顏色不對");
    await page.getByRole("button", { name: "加入 Review 留言草稿" }).click();

    await page.getByRole("link", { name: "Diff review" }).click();
    await page.getByRole("button", { name: "刪除 Preview 留言" }).click();
    await expect(page.getByRole("region", { name: /Preview 留言/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "退回並附上留言（0）" })).toBeDisabled();
  });
});
