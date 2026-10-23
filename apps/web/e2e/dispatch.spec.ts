import { expect, test } from "./fixtures";

test.describe("派工對話框", () => {
  test("選擇 Agent、model、Permission Policy 後派工，進入 Run 頁", async ({ page }) => {
    await page.goto("/tasks/ORB-2");
    await page.getByRole("button", { name: "派工" }).click();
    const dialog = page.getByRole("dialog", { name: "派工 ORB-2" });

    // 預設：我的電腦、第一個可用的 Agent、auto
    await expect(dialog.getByRole("radio", { name: "我的電腦" })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: /^claude-code/ })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: /^auto/ })).toBeChecked();

    // 不可用的 Agent 顯示原因並停用
    await expect(dialog.getByRole("radio", { name: /^codex/ })).toBeDisabled();
    await expect(dialog).toContainText("無法使用：未安裝");

    // 有 Permission Policy 無法攔截的操作時顯示警告
    await dialog.getByRole("radio", { name: /^gemini-cli/ }).check();
    await expect(dialog.getByRole("note")).toContainText("MCP server 的工具呼叫不會送出權限請求");

    await dialog.getByRole("radio", { name: /^claude-code/ }).check();
    await dialog.getByLabel("Model").selectOption("claude-sonnet-5-5");
    await dialog.getByRole("radio", { name: /^manual/ }).check();
    await dialog.getByRole("button", { name: "派工" }).click();

    await expect(page).toHaveURL(/\/runs\/run-\d+$/);
    await expect(page.locator(".run-meta")).toContainText("claude-sonnet-5-5");
    await expect(page.locator(".run-meta")).toContainText("manual");
  });

  test("yolo 只在我的電腦提供，選擇時顯示警告", async ({ page }) => {
    await page.goto("/tasks/ORB-2");
    await page.getByRole("button", { name: "派工" }).click();
    const dialog = page.getByRole("dialog", { name: "派工 ORB-2" });

    await dialog.getByRole("radio", { name: /^yolo/ }).check();
    await expect(dialog.getByRole("alert")).toContainText("yolo 會自動允許");

    // 換到 Team Runner：沒有 yolo，政策回到預設 auto
    await dialog.getByRole("radio", { name: "Team Runner" }).check();
    await expect(dialog.getByRole("radio", { name: /^yolo/ })).toHaveCount(0);
    await expect(dialog.getByRole("radio", { name: /^auto/ })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: /^codex/ })).toBeEnabled();
  });

  test.describe("Project 不允許 Member 派工到 Team Runner", () => {
    test.use({ mock: { role: "member", policy: { memberCanDispatchToTeamRunner: false } } });

    test("Member 只看得到我的電腦", async ({ page }) => {
      await page.goto("/tasks/ORB-2");
      await page.getByRole("button", { name: "派工" }).click();
      const dialog = page.getByRole("dialog", { name: "派工 ORB-2" });
      await expect(dialog.getByRole("radio", { name: "我的電腦" })).toBeVisible();
      await expect(dialog.getByRole("radio", { name: "Team Runner" })).toHaveCount(0);
    });
  });

  test.describe("沒有任何 Runner", () => {
    test.use({ mock: { runners: "none" } });

    test("顯示空狀態", async ({ page }) => {
      await page.goto("/tasks/ORB-2");
      await page.getByRole("button", { name: "派工" }).click();
      const dialog = page.getByRole("dialog", { name: "派工 ORB-2" });
      await expect(dialog).toContainText("目前沒有可以派工的 Runner");
      await expect(dialog.getByRole("button", { name: "派工" })).toHaveCount(0);
    });
  });

  test("只有 Ready 的 Task 顯示派工按鈕", async ({ page }) => {
    await page.goto("/tasks/ORB-1");
    await expect(page.getByRole("heading", { name: /設定 CI 快取/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "派工" })).toHaveCount(0);
  });

  test.describe("Project 預設 Permission Policy 是 manual", () => {
    test.use({ mock: { policy: { defaultPermissionPolicy: "manual" } } });

    test("派工對話框預設選 Project 的政策", async ({ page }) => {
      await page.goto("/tasks/ORB-2");
      await page.getByRole("button", { name: "派工" }).click();
      const dialog = page.getByRole("dialog", { name: "派工 ORB-2" });
      await expect(dialog.getByRole("radio", { name: /^manual/ })).toBeChecked();
      await expect(dialog.getByText("（Project 預設）")).toBeVisible();
      await dialog.getByRole("button", { name: "派工" }).click();
      await expect(page.locator(".run-meta")).toContainText("manual");
    });
  });

  test.describe("Project 預設 Permission Policy 是 yolo", () => {
    test.use({ mock: { policy: { defaultPermissionPolicy: "yolo" } } });

    test("我的電腦預設 yolo；Team Runner 不提供時改用 auto 並說明", async ({ page }) => {
      await page.goto("/tasks/ORB-2");
      await page.getByRole("button", { name: "派工" }).click();
      const dialog = page.getByRole("dialog", { name: "派工 ORB-2" });
      await expect(dialog.getByRole("radio", { name: /^yolo/ })).toBeChecked();
      await expect(dialog.getByRole("alert")).toContainText("yolo 會自動允許");

      await dialog.getByRole("radio", { name: "Team Runner" }).check();
      await expect(dialog.getByRole("radio", { name: /^auto/ })).toBeChecked();
      await expect(dialog.getByRole("note")).toContainText(
        "Project 預設是 yolo，但Team Runner不提供",
      );
    });
  });
});
