import { API_ROUTES, apiPath } from "@orbis/api-contract";
import type { Page } from "@playwright/test";
import { apiCall, card, column, createTask, dragTo, drop, expect, test } from "./fixtures";

/** 切到分欄檢視。 */
async function columnsView(page: Page) {
  await page.goto("/board");
  await page.getByRole("radio", { name: "分欄" }).click();
  await expect(page.getByTestId("board-columns")).toBeVisible();
}

const group = (page: Page, status: string) =>
  page.getByTestId("board-list").locator(`.bd-group[data-status="${status}"]`);

test.describe("看板：列表", () => {
  test("依狀態分組，完成預設收合；列連到工作區", async ({ page }) => {
    await page.goto("/board");
    await expect(group(page, "backlog")).toContainText("設定 CI 快取");
    await expect(group(page, "ready")).toContainText("新增 hello.txt 並更新 README");
    await expect(group(page, "review_gate")).toContainText("整理 README");
    // 審查關卡的列顯示 Run 狀態與代理
    await expect(card(page, "ORB-4")).toContainText("等待審查關卡");
    await expect(card(page, "ORB-4")).toContainText("claude-code");

    const done = group(page, "done");
    await expect(done.locator("[data-task-key]")).toHaveCount(0);
    await done.getByRole("button", { name: /完成/ }).click();
    await expect(done).toContainText("升級相依套件");

    await card(page, "ORB-1").getByRole("link", { name: "設定 CI 快取" }).click();
    await expect(page).toHaveURL(/\/tasks\/ORB-1$/);
  });

  test("篩選：待我處理與指派給我", async ({ page }) => {
    await page.goto("/board");
    await page.getByRole("radio", { name: /待我處理/ }).click();
    await expect(page.locator("[data-task-key]")).toHaveCount(2);
    await expect(card(page, "ORB-3")).toBeVisible();
    await expect(card(page, "ORB-4")).toBeVisible();
    await page.getByRole("radio", { name: "指派給我" }).click();
    await expect(card(page, "ORB-4")).toHaveCount(0);
    await page.getByRole("radio", { name: "全部" }).click();
    await expect(card(page, "ORB-1")).toBeVisible();
  });

  test("Agent 提出的草稿列在待辦，點擊開啟草稿任務頁", async ({ page }) => {
    await page.goto("/board");
    const draft = group(page, "backlog").locator(".bd-row", { hasText: "草稿" }).first();
    await draft.click();
    await expect(page).toHaveURL(/\/projects\/project-1\/draft-tasks$/);
  });

  test("切換 Project", async ({ page }) => {
    await page.goto("/board");
    await page.getByRole("button", { name: /專案 核心產品/ }).click();
    await page.getByRole("menuitemradio", { name: /文件網站/ }).click();
    await expect(page).toHaveURL(/project=project-2/);
    await expect(page.locator("[data-task-key]")).toHaveCount(0);
  });

  test("待辦的列拖到就緒分組", async ({ page }) => {
    await page.goto("/board");
    await dragTo(page, card(page, "ORB-1"), group(page, "ready").locator(".bd-group-head"));
    await expect(group(page, "ready")).toHaveAttribute("data-drop-allowed", "true");
    await drop(page);
    await expect(group(page, "ready").locator('[data-task-key="ORB-1"]')).toBeVisible();
  });
});

test.describe("看板：分欄", () => {
  test("待辦拖到就緒，重新整理後仍在就緒", async ({ page }) => {
    await columnsView(page);
    await dragTo(page, card(page, "ORB-1"), column(page, "ready"));
    await expect(column(page, "ready")).toHaveAttribute("data-drop-allowed", "true");
    await expect(column(page, "done")).toHaveAttribute("data-drop-allowed", "false");
    await drop(page);
    await expect(column(page, "ready").locator('[data-task-key="ORB-1"]')).toBeVisible();

    await page.reload();
    // 檢視記在 localStorage，重新整理後仍是分欄
    await expect(column(page, "ready").locator('[data-task-key="ORB-1"]')).toBeVisible();
  });

  test("不合法的轉換不可放置：待辦拖到完成不會移動", async ({ page }) => {
    await columnsView(page);
    await dragTo(page, card(page, "ORB-1"), column(page, "done"));
    await expect(column(page, "done")).toHaveAttribute("data-drop-allowed", "false");
    await drop(page);
    await expect(column(page, "backlog").locator('[data-task-key="ORB-1"]')).toBeVisible();
    await expect(column(page, "done").locator('[data-task-key="ORB-1"]')).toHaveCount(0);
  });

  test("系統推進的狀態（審查關卡）的卡片不能拖曳", async ({ page }) => {
    await columnsView(page);
    await dragTo(page, card(page, "ORB-4"), column(page, "backlog"));
    await expect(page.locator(".bd-column[data-drop-allowed]")).toHaveCount(0);
    await drop(page);
    await expect(column(page, "review_gate").locator('[data-task-key="ORB-4"]')).toBeVisible();
  });

  test("就緒拖到執行中會打開派工對話框", async ({ page }) => {
    await columnsView(page);
    await dragTo(page, card(page, "ORB-2"), column(page, "running"));
    await expect(column(page, "running")).toHaveAttribute("data-drop-allowed", "true");
    await drop(page);
    const dialog = page.getByRole("dialog", { name: "派工 ORB-2" });
    await expect(dialog).toBeVisible();
    // 取消後不轉換
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(column(page, "ready").locator('[data-task-key="ORB-2"]')).toBeVisible();
  });

  test("Done 依關閉原因顯示不同標記", async ({ page }) => {
    await columnsView(page);
    await expect(card(page, "ORB-5").locator("[data-done-reason]")).toHaveAttribute(
      "data-done-reason",
      "completed",
    );
    await expect(card(page, "ORB-5")).toContainText("已完成");
    await expect(card(page, "ORB-7").locator("[data-done-reason]")).toHaveAttribute(
      "data-done-reason",
      "not_planned",
    );
    await expect(card(page, "ORB-7")).toContainText("不處理");

    await page.goto("/tasks/ORB-7");
    await expect(page.locator(".rp-meta [data-done-reason]")).toHaveText("不處理");
  });
});

test.describe("看板：新增任務", () => {
  test("新增任務後進入工作區，看板的待辦出現新任務", async ({ page }) => {
    await page.goto("/board");
    await createTask(page, { title: "修正登入頁的錯字", description: "把「登人」改成「登入」。" });
    await expect(page).toHaveURL(/\/tasks\/ORB-8$/);
    await expect(page.getByRole("heading", { name: /修正登入頁的錯字/ })).toBeVisible();

    await page.goto("/board");
    await expect(page.locator('.bd-group[data-status="backlog"]')).toContainText(
      "修正登入頁的錯字",
    );
  });
});

test("不符合進入就緒的條件時顯示 Server 的錯誤並還原", async ({ page }) => {
  await page.goto("/board");
  // 準備一個沒有描述與驗收條件的 Task
  await apiCall(page, "POST", apiPath(API_ROUTES.projectTasks, { projectId: "project-1" }), {
    repoId: "repo-1",
    title: "還沒寫好的 Task",
  });
  await columnsView(page);
  await dragTo(page, card(page, "ORB-8"), column(page, "ready"));
  await drop(page);
  // 依 Server 回的 missing 列出缺少的項目
  await expect(page.getByRole("alert")).toContainText("描述或規格");
  await expect(page.getByRole("alert")).toContainText("至少一條驗收條件");
  await expect(column(page, "backlog").locator('[data-task-key="ORB-8"]')).toBeVisible();
});
