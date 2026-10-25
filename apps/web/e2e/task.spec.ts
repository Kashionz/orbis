import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** 右側任務分頁的規格內嵌編輯。 */
async function editSpec(page: Page) {
  await page.getByRole("tabpanel").getByRole("button", { name: "編輯", exact: true }).click();
  await expect(page.getByTestId("collab-status")).toHaveText("已同步");
}

const drafts = (page: Page) => page.locator(".rp-draft");
const criteria = (page: Page) => page.locator(".rp-criterion");

test.describe("任務分頁", () => {
  test("規格以共同編輯修改：markdown 語法轉成標題與清單，重新整理後仍在", async ({ page }) => {
    await page.goto("/tasks/ORB-1");
    await editSpec(page);
    const description = page.getByRole("textbox", { name: "規格" });
    await description.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("## 背景");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- 第一點");
    await page.keyboard.press("Enter");
    await page.keyboard.type("第二點");
    await expect(description.getByRole("heading", { name: "背景" })).toBeVisible();

    await page.reload();
    await editSpec(page);
    await expect(description.getByRole("listitem")).toHaveText(["第一點", "第二點"]);
  });

  test("編輯標題：未儲存的提示、Esc 取消、Ctrl+Enter 儲存", async ({ page }) => {
    await page.goto("/tasks/ORB-1");
    await editSpec(page);
    const title = page.getByLabel("標題");
    await title.fill("設定 CI 快取（暫時）");
    await expect(page.locator(".rp-unsaved")).toHaveText("未儲存");
    await title.press("Escape");
    await expect(title).toHaveCount(0);
    await expect(page.locator(".wk-header-title")).toHaveText("設定 CI 快取");

    await editSpec(page);
    await page.getByLabel("標題").fill("設定 CI 快取（pnpm store）");
    await page.getByLabel("標題").press("ControlOrMeta+Enter");
    await expect(page.locator(".wk-header-title")).toHaveText("設定 CI 快取（pnpm store）");
  });

  test("驗收條件：新增、切換類型、排序、刪除，儲存後一次送出", async ({ page }) => {
    await page.goto("/tasks/ORB-2");
    await expect(criteria(page)).toHaveCount(2);
    await expect(criteria(page).nth(0)).toContainText("測試通過");
    await expect(criteria(page).nth(0)).toContainText("pnpm test");
    await editSpec(page);
    await expect(drafts(page)).toHaveCount(2);

    // 新增：預設是代理判定；改成指令且留空時警告會沿用儲存庫設定檔的 [verify].commands（#53 的觀察）
    await page.getByRole("button", { name: "新增條件" }).click();
    const added = drafts(page).nth(2);
    await added.getByLabel("條件描述").fill("hello.txt 的內容符合規格");
    await added.getByRole("button", { name: /條件類型/ }).click();
    await page.getByRole("menuitemradio", { name: /指令/ }).click();
    await expect(added.getByRole("alert")).toContainText("[verify].commands");
    await expect(added.getByRole("alert")).toContainText("無法判定");
    await added.getByLabel("指令", { exact: true }).fill("pnpm lint");
    await expect(added.getByRole("alert")).toHaveCount(0);
    // 再改回代理判定（不顯示指令欄位）
    await added.getByRole("button", { name: /條件類型/ }).click();
    await page.getByRole("menuitemradio", { name: /代理判定/ }).click();
    await expect(added.getByLabel("指令", { exact: true })).toHaveCount(0);

    // 第一條改成人工、下移；刪掉第二條
    await drafts(page)
      .nth(0)
      .getByRole("button", { name: /條件類型/ })
      .click();
    await page.getByRole("menuitemradio", { name: /人工/ }).click();
    await drafts(page).nth(0).getByRole("button", { name: "下移" }).click();
    await expect(drafts(page).nth(1).getByLabel("條件描述")).toHaveValue("測試通過");
    await drafts(page).nth(0).getByRole("button", { name: "移除" }).click();
    await page.getByRole("button", { name: "儲存", exact: true }).click();

    await expect(criteria(page)).toHaveCount(2);
    await expect(criteria(page).nth(0)).toHaveAttribute("data-kind", "manual");
    await expect(criteria(page).nth(0)).not.toContainText("pnpm test");
    await expect(criteria(page).nth(1)).toHaveAttribute("data-kind", "agent");
    await page.reload();
    await expect(criteria(page)).toHaveCount(2);
    await expect(criteria(page).nth(0)).toContainText("測試通過");
  });

  test("設定指派對象與依賴", async ({ page }) => {
    await page.goto("/tasks/ORB-1");
    await page.getByRole("button", { name: "指派對象" }).click();
    await page.getByRole("menuitemradio", { name: /@bob/ }).click();
    await expect(page.getByRole("button", { name: "指派對象" })).toContainText("@bob");

    await page.getByRole("button", { name: "依賴" }).click();
    await page.getByRole("menuitemradio", { name: /ORB-2 新增 hello.txt/ }).click();
    await page.keyboard.press("Escape");
    const dependsOn = page.getByRole("button", { name: "依賴" });
    await expect(dependsOn).toContainText("ORB-2");
    await expect(dependsOn).toContainText("就緒");

    await page.reload();
    await expect(page.getByRole("button", { name: "指派對象" })).toContainText("@bob");
    await page.getByRole("button", { name: "依賴" }).click();
    await page.getByRole("menuitemradio", { name: /ORB-2 新增 hello.txt/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "依賴" })).toHaveText("無");
  });

  test("執行紀錄切換工作區顯示的 Run", async ({ page }) => {
    await page.goto("/tasks/ORB-4");
    const rows = page.locator(".rp-run");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("claude-code");
    await expect(rows.first()).toContainText("等待關卡");
    await expect(rows.first()).toHaveAttribute("data-current", "true");
    await rows.first().getByRole("button").first().click();
    await expect(page).toHaveURL(/\/tasks\/ORB-4\?run=run-\d+$/);
  });

  test("找不到的 Task Key 顯示錯誤", async ({ page }) => {
    await page.goto("/tasks/ORB-999");
    await expect(page.getByRole("heading", { name: "無法載入這個頁面" })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("依賴中有 Task 還沒完成時不能派工", async ({ page }) => {
    await page.goto("/tasks/ORB-2");
    const dependsOn = page.getByRole("button", { name: "依賴" });
    await dependsOn.click();
    await page.getByRole("menuitemradio", { name: /ORB-1 設定 CI 快取/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("note")).toContainText("依賴的 ORB-1 尚未完成，不能派工");
    await expect(page.getByRole("form", { name: "派工" })).toHaveCount(0);

    // 換成已經完成的 ORB-5 就可以派工
    await dependsOn.click();
    await page.getByRole("menuitemradio", { name: /ORB-1 設定 CI 快取/ }).click();
    await page.getByRole("menuitemradio", { name: /ORB-5 升級相依套件/ }).click();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("form", { name: "派工" }).getByRole("button", { name: "派工" }),
    ).toBeEnabled();
  });
});
