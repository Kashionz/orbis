import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** 工作區還沒有執行時的派工表單。 */
async function openForm(page: Page, taskKey = "ORB-2") {
  await page.goto(`/tasks/${taskKey}`);
  const form = page.getByRole("form", { name: "派工" });
  await expect(form).toBeVisible();
  return form;
}

test.describe("派工表單", () => {
  test("選擇代理、模型、權限策略後派工，工作區切到新的執行", async ({ page }) => {
    const form = await openForm(page);

    // 預設：我的電腦、第一個可用的代理、自動
    await expect(form.getByRole("radio", { name: /我的電腦/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(form.getByRole("radio", { name: /claude-code/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(form.getByRole("radio", { name: "自動" })).toHaveAttribute("aria-checked", "true");

    // 不可用的代理顯示原因並停用
    await expect(form.getByRole("radio", { name: /codex/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(form).toContainText("未安裝");

    // 有權限策略無法攔截的操作時顯示警告
    await form.getByRole("radio", { name: /antigravity/ }).click();
    await expect(form.getByRole("note")).toContainText("MCP server 的工具呼叫不會送出權限請求");

    await form.getByRole("radio", { name: /claude-code/ }).click();
    await form.getByLabel("模型").selectOption("claude-sonnet-5-5");
    await form.getByRole("radio", { name: "逐一確認" }).click();
    await form.getByRole("button", { name: "派工" }).click();

    await expect(page).toHaveURL(/\/tasks\/ORB-2\?run=run-\d+$/);
    await expect(page.getByRole("button", { name: /切換模型 Sonnet 5\.5/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "權限策略 逐一確認" })).toBeVisible();
  });

  test("全部允許只在我的電腦提供，選擇時顯示警告", async ({ page }) => {
    const form = await openForm(page);
    await form.getByRole("radio", { name: "全部允許" }).click();
    await expect(form.getByRole("alert")).toContainText("「全部允許」會在這台電腦上自動允許");

    // 換到團隊執行器：沒有全部允許，政策回到預設的自動
    await form.getByRole("radio", { name: /團隊執行器/ }).click();
    await expect(form.getByRole("radio", { name: "全部允許" })).toHaveCount(0);
    await expect(form.getByRole("radio", { name: "自動" })).toHaveAttribute("aria-checked", "true");
    await expect(form.getByRole("radio", { name: /codex/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  test.describe("Project 不允許 Member 派工到 Team Runner", () => {
    test.use({ mock: { role: "member", policy: { memberCanDispatchToTeamRunner: false } } });

    test("Member 只看得到我的電腦", async ({ page }) => {
      const form = await openForm(page);
      await expect(form.getByRole("radio", { name: /我的電腦/ })).toBeVisible();
      await expect(form.getByRole("radio", { name: /團隊執行器/ })).toHaveCount(0);
    });
  });

  test.describe("沒有任何 Runner", () => {
    test.use({ mock: { runners: "none" } });

    test("顯示空狀態", async ({ page }) => {
      await page.goto("/tasks/ORB-2");
      await expect(page.locator(".wk-norun")).toContainText("目前沒有可以派工的執行器");
      await expect(page.getByRole("form", { name: "派工" })).toHaveCount(0);
    });
  });

  test.describe("我的 Local Runner 離線", () => {
    test.use({ mock: { runners: "local-offline" } });

    test("提示派工後會排隊，代理沿用最後回報的可用性，仍然可以派工（§6.1）", async ({ page }) => {
      const form = await openForm(page);
      await expect(form).toContainText("執行器目前離線，派工後會排隊，上線後才開始");
      await expect(form.getByRole("radio", { name: /claude-code/ })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await expect(form.getByRole("radio", { name: /codex/ })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await form.getByRole("button", { name: "派工" }).click();
      await expect(page).toHaveURL(/\/tasks\/ORB-2\?run=run-\d+$/);
    });
  });

  test("只有就緒的 Task 顯示派工表單；待辦列出還缺什麼", async ({ page }) => {
    await page.goto("/tasks/ORB-1");
    await expect(page.locator(".wk-header-title")).toHaveText("設定 CI 快取");
    await expect(page.getByRole("form", { name: "派工" })).toHaveCount(0);
    await expect(page.locator(".wk-checklist")).toBeVisible();
  });

  test.describe("Project 預設 Permission Policy 是 manual", () => {
    test.use({ mock: { policy: { defaultPermissionPolicy: "manual" } } });

    test("派工表單預設選 Project 的政策", async ({ page }) => {
      const form = await openForm(page);
      await expect(form.getByRole("radio", { name: "逐一確認" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(form.getByText("專案預設：逐一確認")).toBeVisible();
      await form.getByRole("button", { name: "派工" }).click();
      await expect(page.getByRole("button", { name: "權限策略 逐一確認" })).toBeVisible();
    });
  });

  test.describe("Project 預設 Permission Policy 是 yolo", () => {
    test.use({ mock: { policy: { defaultPermissionPolicy: "yolo" } } });

    test("我的電腦預設全部允許；團隊執行器不提供時改用自動並說明", async ({ page }) => {
      const form = await openForm(page);
      await expect(form.getByRole("radio", { name: "全部允許" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(form.getByRole("alert")).toContainText("「全部允許」會在這台電腦上自動允許");

      await form.getByRole("radio", { name: /團隊執行器/ }).click();
      await expect(form.getByRole("radio", { name: "自動" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(form.getByRole("note")).toContainText(
        "專案預設是「全部允許」，這種執行器不提供",
      );
    });
  });
});
