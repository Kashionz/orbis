// 即時共同編輯（#40），MSW 假後端版：單一頁面的編輯、保存與回寫、唯讀、close code、在線名單與
// 另一位成員的修改（假後端模擬）、@mention。兩個瀏覽器 context 的同步在 e2e/system/collab.spec.ts。

import type { Page } from "@playwright/test";
import { placeCaretAtEnd } from "./collab-helpers";
import { expect, test } from "./fixtures";

const description = (page: Page) => page.getByRole("textbox", { name: "規格" });

/**
 * 等編輯器以文件內容渲染完成、連線同步之後再操作。`edit` 為 true 時先按任務分頁的「編輯」
 * （檢視時規格是唯讀的共同編輯文件）。
 */
async function ready(page: Page, edit = true) {
  if (edit) {
    await page.getByRole("tabpanel").getByRole("button", { name: "編輯", exact: true }).click();
  }
  await expect(page.getByTestId("collab-status").first()).toHaveText("已同步");
  await expect(description(page)).toBeVisible();
}

async function typeAtEnd(page: Page, text: string) {
  await placeCaretAtEnd(description(page));
  await page.keyboard.type(text);
}

test("Task 描述以 TipTap 共同編輯，內容保存後重新整理仍在，並回寫 Task 描述", async ({ page }) => {
  await page.goto("/tasks/ORB-1");
  await ready(page);
  await expect(description(page)).toContainText("CI 的 pnpm store 加上快取。");
  await typeAtEnd(page, "");
  await page.keyboard.press("Enter");
  await page.keyboard.type("第二段：加上 restore-keys。");
  await expect(description(page)).toContainText("第二段：加上 restore-keys。");

  await page.reload();
  await ready(page);
  await expect(description(page).locator("p")).toHaveText([
    "CI 的 pnpm store 加上快取。",
    "第二段：加上 restore-keys。",
  ]);
});

test("清空描述後 Ready 條件即時顯示還缺描述", async ({ page }) => {
  await page.goto("/tasks/ORB-1");
  await ready(page);
  await description(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await expect(page.locator(".wk-checklist li").nth(1)).toHaveAttribute("data-met", "true");
  // ORB-1 連結了 Spec，所以描述是空的也算滿足
  await expect(page.getByRole("link", { name: "docs/specs/login.md" })).toBeVisible();
});

test("在描述中 @agent：插入 mention 節點，顯示 consult Run 的連結", async ({ page }) => {
  await page.goto("/tasks/ORB-1");
  await ready(page);
  await typeAtEnd(page, " @cla");
  const listbox = page.getByRole("listbox", { name: "提及的對象" });
  await expect(listbox.getByRole("option")).toHaveText(["@claude Agent（claude-code）"]);
  await page.keyboard.press("Enter");
  await expect(description(page).locator(".mention")).toHaveText("@claude");
  await expect(page.getByRole("link", { name: "@claude 的諮詢執行" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator(".rp-run").first()).toContainText("@agent");
});

test.describe("另一位成員也在編輯", () => {
  test.use({ mock: { eventIntervalMs: 20, collabPeer: "edit" } });

  test("檢視時也顯示在線名單，對方的修改即時出現", async ({ page }) => {
    await page.goto("/tasks/ORB-1");
    await expect(page.getByRole("list", { name: "正在編輯的人" })).toHaveText("alice");
    await expect(description(page)).toContainText("alice 補充的一段");
  });
});

test.describe("Viewer", () => {
  test.use({ mock: { eventIntervalMs: 20, role: "viewer" } });

  test("唯讀：看得到內容但不能輸入", async ({ page }) => {
    await page.goto("/tasks/ORB-1");
    await expect(page.locator(".collab").first().getByText("唯讀")).toBeVisible();
    await expect(description(page)).toHaveAttribute("contenteditable", "false");
    await expect(description(page)).toContainText("CI 的 pnpm store 加上快取。");
  });
});

for (const [code, message] of [
  [4401, "登入已失效，請重新登入後再編輯。"],
  [4403, "沒有權限查看這份文件。"],
] as const) {
  test.describe(`連線被以 ${code} 關閉`, () => {
    test.use({ mock: { eventIntervalMs: 20, collabClose: code } });

    test("顯示原因，不再重連", async ({ page }) => {
      await page.goto("/tasks/ORB-1");
      await expect(page.locator(".collab").first().getByRole("alert")).toHaveText(message);
      await expect(page.getByTestId("collab-status").first()).toHaveText("已中斷");
    });
  });
}

test("Acceptance Criterion 的描述也可以共同編輯，結束後清單更新", async ({ page }) => {
  await page.goto("/tasks/ORB-2");
  const first = page.locator(".rp-criterion").first();
  await first.locator(".rp-criterion-row").click();
  await first.getByRole("button", { name: "共同編輯描述" }).click();
  const editor = first.getByRole("textbox", { name: "條件「測試通過」的描述" });
  await expect(editor).toContainText("測試通過");
  await placeCaretAtEnd(editor);
  await page.keyboard.type("（含 e2e）");
  await expect(editor).toContainText("測試通過（含 e2e）");
  await first.getByRole("button", { name: "結束共同編輯" }).click();
  await expect(first.locator(".rp-criterion-desc")).toHaveText("測試通過（含 e2e）");
});
