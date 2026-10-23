import { expect, test } from "./fixtures";

test.describe("Task 頁", () => {
  test("編輯描述：預覽 markdown，儲存後重新整理仍在", async ({ page }) => {
    await page.goto("/tasks/ORB-1");
    await page.getByRole("button", { name: "編輯描述" }).click();
    await page.getByLabel("描述（markdown）").fill("## 背景\n\n- 第一點\n- 第二點");
    await page.getByRole("tab", { name: "預覽" }).click();
    await expect(page.getByRole("heading", { name: "背景" })).toBeVisible();
    await page.getByRole("button", { name: "儲存描述" }).click();

    const description = page.getByTestId("description");
    await expect(description.getByRole("heading", { name: "背景" })).toBeVisible();
    await page.reload();
    await expect(description.getByRole("listitem")).toHaveText(["第一點", "第二點"]);
  });

  test("編輯標題", async ({ page }) => {
    await page.goto("/tasks/ORB-1");
    await page.getByRole("button", { name: "編輯標題" }).click();
    await page.getByLabel("標題").fill("設定 CI 快取（pnpm store）");
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await expect(page.getByRole("heading", { name: /設定 CI 快取（pnpm store）/ })).toBeVisible();
  });

  test("Acceptance Criterion：新增、切換類型、排序、刪除", async ({ page }) => {
    await page.goto("/tasks/ORB-2");
    const list = page.locator(".ac-list > li");
    await expect(list).toHaveCount(2);
    await expect(list.nth(0)).toContainText("測試通過");
    await expect(list.nth(0)).toContainText("pnpm test");

    // 新增 agent 類型（不顯示指令欄位）
    await page.getByRole("button", { name: "新增 Acceptance Criterion" }).click();
    const form = page.locator(".ac-form");
    await form.getByLabel("類型").selectOption("agent");
    await expect(form.getByLabel("指令", { exact: true })).toHaveCount(0);
    await form.getByLabel("條件").fill("hello.txt 的內容符合 Spec");
    await form.getByRole("button", { name: "加入" }).click();
    await expect(list).toHaveCount(3);
    await expect(list.nth(2)).toHaveAttribute("data-kind", "agent");

    // command 改成 manual：指令被清掉
    await list.nth(0).getByRole("button", { name: "編輯" }).click();
    await list.nth(0).getByLabel("類型").selectOption("manual");
    await list.nth(0).getByRole("button", { name: "儲存" }).click();
    await expect(list.nth(0)).toHaveAttribute("data-kind", "manual");
    await expect(list.nth(0)).not.toContainText("pnpm test");

    // 下移第一條
    await list.nth(0).getByRole("button", { name: "下移" }).click();
    await expect(list.nth(1)).toContainText("測試通過");

    await list.nth(2).getByRole("button", { name: "刪除" }).click();
    await expect(list).toHaveCount(2);
    await page.reload();
    await expect(list).toHaveCount(2);
    await expect(list.nth(0)).toContainText("README 文字通順");
  });

  test("設定指派對象與 depends_on", async ({ page }) => {
    await page.goto("/tasks/ORB-1");
    await page.getByLabel("指派對象").selectOption({ label: "@bob（Bob）" });
    await expect(page.getByLabel("指派對象")).toHaveValue("member-bob");

    await page.getByLabel("以 Task Key 加入依賴").fill("ORB-2");
    await page.getByRole("button", { name: /ORB-2 新增 hello.txt/ }).click();
    const dependency = page.locator(".depends-list li");
    await expect(dependency).toHaveCount(1);
    await expect(dependency.getByRole("link", { name: "ORB-2" })).toBeVisible();
    await expect(dependency).toContainText("Ready");

    await page.reload();
    await expect(page.getByLabel("指派對象")).toHaveValue("member-bob");
    await dependency.getByRole("button", { name: "移除依賴 ORB-2" }).click();
    await expect(dependency).toHaveCount(0);
  });

  test("Run 樹連到 Run 即時檢視", async ({ page }) => {
    await page.goto("/tasks/ORB-4");
    const rows = page.locator(".run-node");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("claude-code");
    await expect(rows.first()).toContainText("我的電腦");
    await expect(rows.first()).toContainText("等待 Gate");
    await rows.first().getByRole("link", { name: "開啟 Run 頁" }).click();
    await expect(page).toHaveURL(/\/runs\/run-\d+$/);
  });

  test("找不到的 Task Key 顯示錯誤", async ({ page }) => {
    await page.goto("/tasks/ORB-999");
    await expect(page.getByRole("heading", { name: "無法載入這個頁面" })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("depends_on 中有 Task 還沒 Done 時不能派工", async ({ page }) => {
    await page.goto("/tasks/ORB-2");
    await page.getByLabel("以 Task Key 加入依賴").fill("ORB-1");
    await page.getByRole("button", { name: /ORB-1 設定 CI 快取/ }).click();
    await expect(page.getByRole("note")).toContainText("依賴的 ORB-1 還沒有 Done，不能派工");
    await expect(page.getByRole("button", { name: "派工" })).toBeDisabled();

    // 換成已經 Done 的 ORB-5 就可以派工
    await page.getByRole("button", { name: "移除依賴 ORB-1" }).click();
    await page.getByLabel("以 Task Key 加入依賴").fill("ORB-5");
    await page.getByRole("button", { name: /ORB-5 升級相依套件/ }).click();
    await expect(page.getByRole("button", { name: "派工" })).toBeEnabled();
  });
});
