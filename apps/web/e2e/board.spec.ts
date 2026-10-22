import { card, column, dragTo, drop, expect, test } from "./fixtures";

test.describe("看板", () => {
  test("依狀態分欄顯示 Task，卡片連到 Task 頁", async ({ page }) => {
    await page.goto("/board");
    await expect(column(page, "backlog").getByText("設定 CI 快取")).toBeVisible();
    await expect(column(page, "ready").getByText("新增 hello.txt 並更新 README")).toBeVisible();
    await expect(column(page, "review_gate").getByText("整理 README")).toBeVisible();
    await expect(column(page, "done").getByText("升級相依套件")).toBeVisible();

    await card(page, "ORB-1").getByRole("link", { name: "ORB-1" }).click();
    await expect(page).toHaveURL(/\/tasks\/ORB-1$/);
  });

  test("切換 Project", async ({ page }) => {
    await page.goto("/board");
    await page.getByLabel("Project").selectOption({ label: "文件網站（DOC）" });
    await expect(page).toHaveURL(/project=project-2/);
    await expect(page.locator("[data-task-key]")).toHaveCount(0);
  });

  test("用 Task Key 搜尋，完整的 Key 按 Enter 直接開啟", async ({ page }) => {
    await page.goto("/board");
    const search = page.getByLabel("用 Task Key 搜尋");
    await search.fill("orb-2");
    await expect(page.locator("[data-task-key]")).toHaveCount(1);
    await expect(card(page, "ORB-2")).toBeVisible();

    await search.fill("4");
    await expect(page.locator("[data-task-key]")).toHaveCount(1);
    await expect(card(page, "ORB-4")).toBeVisible();

    await search.fill("ORB-2");
    await search.press("Enter");
    await expect(page).toHaveURL(/\/tasks\/ORB-2$/);
  });

  test("Backlog 拖到 Ready，重新整理後仍在 Ready", async ({ page }) => {
    await page.goto("/board");
    await dragTo(page, card(page, "ORB-1"), column(page, "ready"));
    await expect(column(page, "ready")).toHaveAttribute("data-drop-allowed", "true");
    await expect(column(page, "done")).toHaveAttribute("data-drop-allowed", "false");
    await drop(page);
    await expect(column(page, "ready").locator('[data-task-key="ORB-1"]')).toBeVisible();

    await page.reload();
    await expect(column(page, "ready").locator('[data-task-key="ORB-1"]')).toBeVisible();
  });

  test("不合法的轉換不可放置：Backlog 拖到 Done 不會移動", async ({ page }) => {
    await page.goto("/board");
    await dragTo(page, card(page, "ORB-1"), column(page, "done"));
    await expect(column(page, "done")).toHaveAttribute("data-drop-allowed", "false");
    await drop(page);
    await expect(column(page, "backlog").locator('[data-task-key="ORB-1"]')).toBeVisible();
    await expect(column(page, "done").locator('[data-task-key="ORB-1"]')).toHaveCount(0);
  });

  test("系統推進的狀態（Review Gate）的卡片不能拖曳", async ({ page }) => {
    await page.goto("/board");
    await dragTo(page, card(page, "ORB-4"), column(page, "backlog"));
    await expect(page.locator(".board-column[data-drop-allowed]")).toHaveCount(0);
    await drop(page);
    await expect(column(page, "review_gate").locator('[data-task-key="ORB-4"]')).toBeVisible();
  });

  test("Ready 拖到 Running 會打開派工對話框", async ({ page }) => {
    await page.goto("/board");
    await dragTo(page, card(page, "ORB-2"), column(page, "running"));
    await expect(column(page, "running")).toHaveAttribute("data-drop-allowed", "true");
    await drop(page);
    await expect(page.getByRole("dialog", { name: "派工 ORB-2" })).toBeVisible();
    // 取消後不轉換
    await page.getByRole("button", { name: "取消" }).click();
    await expect(column(page, "ready").locator('[data-task-key="ORB-2"]')).toBeVisible();
  });

  test("新增 Task 後進入 Task 頁，看板出現在 Backlog", async ({ page }) => {
    await page.goto("/board");
    await page.getByRole("button", { name: "新增 Task" }).click();
    const dialog = page.getByRole("dialog", { name: "新增 Task" });
    await dialog.getByLabel("標題").fill("修正登入頁的錯字");
    await dialog.getByLabel("描述（markdown）").fill("把「登人」改成「登入」。");
    await dialog.getByRole("button", { name: "建立" }).click();
    await expect(page).toHaveURL(/\/tasks\/ORB-7$/);
    await expect(page.getByRole("heading", { name: /修正登入頁的錯字/ })).toBeVisible();

    await page.getByRole("link", { name: "核心產品" }).click();
    await expect(column(page, "backlog").getByText("修正登入頁的錯字")).toBeVisible();
  });
});
