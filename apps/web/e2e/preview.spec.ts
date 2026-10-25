// 工作區的預覽分頁（PreviewPanel）與差異分頁的預覽留言：退回時和行內留言一起送出。

import type { GateDecisionInput } from "@orbis/api-contract";
import type { Page } from "@playwright/test";
import { expect, mockState, test } from "./fixtures";

/** 1×1 的 PNG。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

type Reviews = { reviews: Record<string, GateDecisionInput[]> };

/** 打開 ORB-4（等待審查關卡）的工作區，回傳 Run 的 id。 */
async function openReviewRun(page: Page): Promise<string> {
  await page.goto("/tasks/ORB-4");
  await page.locator(".rp-run").first().locator(".rp-run-open").click();
  await expect(page).toHaveURL(/\/tasks\/ORB-4\?run=run-\d+$/);
  return new URL(page.url()).searchParams.get("run") ?? "";
}

const previewTab = (page: Page) => page.getByRole("tab", { name: /預覽/ });
const diffTab = (page: Page) => page.getByRole("tab", { name: /差異/ });

/** 在預覽分頁附上截圖、寫留言、加入草稿。 */
async function addDraft(page: Page, body: string) {
  await page.getByRole("button", { name: "附上整頁截圖留言" }).click();
  await page
    .getByLabel("選擇截圖")
    .setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
  const form = page.getByRole("form", { name: "預覽留言" });
  await form.getByLabel("留言內容").fill(body);
  await form.getByRole("button", { name: "加入審查留言草稿" }).click();
}

test("沒有設定 Preview 時顯示說明", async ({ page }) => {
  await openReviewRun(page);
  await previewTab(page).click();
  await expect(page.getByText("這個儲存庫沒有設定預覽")).toBeVisible();
});

test.describe("Preview 已就緒", () => {
  test.use({ mock: { eventIntervalMs: 20, preview: true } });

  test.beforeEach(async ({ page }) => {
    // 測試環境不能用 getDisplayMedia 截圖，改走貼上或上傳圖片的後備
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { value: undefined });
    });
  });

  test("在預覽分頁留言成草稿，差異分頁列出並在退回時一起送出", async ({ page }) => {
    const runId = await openReviewRun(page);
    await previewTab(page).click();
    await expect(page.locator('iframe[title="預覽"]')).toHaveAttribute(
      "src",
      "http://127.0.0.1:9/",
    );
    // 桌面／行動裝置的寬度切換
    await page.getByRole("radio", { name: "行動裝置" }).click();
    await expect(page.locator('iframe[title="預覽"]')).toHaveAttribute("data-width", "mobile");

    await addDraft(page, "按鈕太小");
    await expect(page.getByRole("region", { name: "預覽留言草稿" })).toContainText("按鈕太小");

    // 差異分頁：只有預覽留言也可以退回
    await diffTab(page).click();
    const drafts = page.getByRole("region", { name: "預覽留言 1" });
    await expect(drafts).toContainText("按鈕太小");
    await expect
      .poll(() => drafts.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "退回（1）" }).click();
    await expect.poll(async () => (await mockState<Reviews>(page)).reviews[runId]).toBeTruthy();

    const sent = (await mockState<Reviews>(page)).reviews[runId]?.at(-1);
    expect(sent).toMatchObject({
      action: "reject",
      previewComments: [{ body: "按鈕太小", selector: null }],
    });
    expect(sent?.action === "reject" && sent.previewComments?.[0]?.screenshotBlobId).toBeTruthy();

    // 送出後草稿清空
    await previewTab(page).click();
    await expect(page.getByRole("region", { name: "預覽留言草稿" })).toHaveCount(0);
  });

  test("差異分頁可以刪除預覽留言草稿", async ({ page }) => {
    await openReviewRun(page);
    await previewTab(page).click();
    await addDraft(page, "顏色不對");

    await diffTab(page).click();
    await page.getByRole("button", { name: "刪除預覽留言" }).click();
    await expect(page.getByRole("region", { name: /預覽留言/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "退回（0）" })).toBeDisabled();
  });
});
