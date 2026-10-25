// 工作區的預覽分頁（PreviewPanel）與差異分頁的預覽留言：退回時和行內留言一起送出；預覽邀請（ADR-0015）。

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

  test("預覽邀請：邀請 GitHub 帳號與 Email，連結只顯示一次，可以撤銷", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await openReviewRun(page);
    await previewTab(page).click();
    const invites = page.getByRole("region", { name: "邀請檢視預覽" });
    const who = invites.getByRole("textbox", { name: "GitHub 帳號或 Email" });

    // 找不到的 GitHub 帳號顯示 Server 的錯誤
    await who.fill("nobody-here");
    await invites.getByRole("button", { name: "邀請", exact: true }).click();
    await expect(invites.getByRole("alert")).toHaveText("找不到 GitHub 帳號 nobody-here");

    await who.fill("@client-reviewer");
    await invites.getByRole("combobox", { name: "期限" }).selectOption("7d");
    await invites.getByRole("button", { name: "邀請", exact: true }).click();
    const created = invites.getByRole("status");
    await expect(created).toContainText("請複製連結傳給對方（只會顯示這一次）");
    await created.getByRole("button", { name: "複製邀請連結" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      /\/preview-invites\/[0-9a-f]{32}$/,
    );

    await who.fill("guest@example.com");
    await invites.getByRole("button", { name: "邀請", exact: true }).click();
    const rows = invites.getByRole("listitem");
    await expect(rows).toHaveCount(2);
    const reviewer = rows.filter({ hasText: "@client-reviewer" });
    await expect(reviewer).toContainText("有效");
    await expect(reviewer).toContainText("還沒開啟");
    await reviewer.getByRole("button", { name: "撤銷" }).click();
    await expect(reviewer).toContainText("已撤銷");
    await expect(reviewer.getByRole("button", { name: "撤銷" })).toHaveCount(0);
    await expect(rows.filter({ hasText: "guest@example.com" })).toContainText("有效");
  });
});

test.describe("Team 沒有開放對外分享預覽", () => {
  test.use({ mock: { preview: true, allowExternalPreview: false } });

  test("預覽邀請只顯示說明", async ({ page }) => {
    await openReviewRun(page);
    await previewTab(page).click();
    const invites = page.getByRole("region", { name: "邀請檢視預覽" });
    await expect(invites).toContainText("團隊設定沒有開放對外分享預覽");
    await expect(invites.getByRole("textbox")).toHaveCount(0);
  });
});
