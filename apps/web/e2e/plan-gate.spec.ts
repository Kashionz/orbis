// Plan Gate（#41）：事件串流顯示待核准的計畫，dock 核准，輸入框送出即退回並附上意見；
// Project 與 Task 層級的開關。

import type { Page } from "@playwright/test";
import { dispatchTask, expect, stream, test } from "./fixtures";

const pendingPlan = (page: Page) => stream(page).locator('.st-plan[data-pending="true"]');
const composer = (page: Page) =>
  page.getByRole("textbox", { name: "說明要怎麼修改計畫，送出即退回" });
const planGateButton = (page: Page) => page.getByRole("button", { name: "計畫關卡" });

test.describe("Plan Gate 開啟時", () => {
  test.use({ mock: { eventIntervalMs: 20, policy: { planGateEnabled: true } } });

  test("顯示計畫；在輸入框退回後 Agent 修訂計畫，核准後開始實作", async ({ page }) => {
    await dispatchTask(page, "ORB-2");
    await expect(pendingPlan(page).getByTestId("plan-body").getByRole("heading")).toHaveText(
      "Plan",
    );
    await expect(pendingPlan(page)).toContainText("新增 hello.txt");
    await expect(pendingPlan(page)).toContainText("計畫模式");
    await expect(page.locator(".cp-dock")).toContainText("等待核准計畫");

    // 退回一定要附意見：沒有文字時不能送出
    const send = page.getByRole("button", { name: "傳送" });
    await expect(send).toHaveAttribute("aria-disabled", "true");
    await composer(page).fill("請補上測試");
    await composer(page).press("Enter");
    await expect(pendingPlan(page).getByTestId("plan-body").getByRole("heading")).toHaveText(
      "Plan（修訂）",
    );
    await expect(pendingPlan(page)).toContainText("補上測試");
    // 退回的意見以人的訊息出現在串流中
    await expect(stream(page).locator(".st-bubble")).toContainText(["請補上測試"]);

    await page.getByRole("button", { name: "核准計畫" }).click();
    await expect(page.locator(".cp-dock")).toHaveCount(0);
    await expect(stream(page)).toContainText("我需要寫入 config.json。");
    await expect(page.locator(".rp-status")).toHaveText("執行中");
  });

  test("等待計畫關卡時 Task 在計畫關卡分組，待我處理也列出", async ({ page }) => {
    await dispatchTask(page, "ORB-2");
    await expect(pendingPlan(page)).toBeVisible();
    await page.goto("/board");
    await expect(page.locator('[data-status="plan_gate"] [data-task-key="ORB-2"]')).toBeVisible();
    await page.goto("/needs-you");
    await expect(page.locator(".ny-row").filter({ hasText: "ORB-2" })).toContainText(
      "等待核准計畫",
    );
  });

  test("在計畫關卡中止執行，Task 回到就緒", async ({ page }) => {
    await dispatchTask(page, "ORB-2");
    await expect(pendingPlan(page)).toBeVisible();
    await page.getByRole("button", { name: "中止執行" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("已中止");
    await expect(page.locator(".rp-status")).toHaveText("就緒");
  });

  test("Task 可以個別關閉 Plan Gate", async ({ page }) => {
    await page.goto("/tasks/ORB-2");
    await expect(planGateButton(page)).toHaveText("沿用專案（開啟）");
    await planGateButton(page).click();
    await page.getByRole("menuitemradio", { name: "關閉" }).click();
    await expect(planGateButton(page)).toHaveText("關閉");
    await dispatchTask(page, "ORB-2");
    await expect(stream(page)).toContainText("我需要寫入 config.json。");
    await expect(pendingPlan(page)).toHaveCount(0);
  });
});

test("Plan Gate 關閉的 Project 中，Task 可以個別開啟", async ({ page }) => {
  await page.goto("/tasks/ORB-2");
  await planGateButton(page).click();
  await page.getByRole("menuitemradio", { name: "開啟" }).click();
  await expect(planGateButton(page)).toHaveText("開啟");
  await dispatchTask(page, "ORB-2");
  await expect(pendingPlan(page)).toBeVisible();
});

test("Project 設定頁可以開啟 Plan Gate 與修改其他政策", async ({ page }) => {
  await page.goto("/projects/project-1/settings");
  const form = page.getByRole("form", { name: "其他政策" });
  await form.getByLabel("需要 Plan Gate（Task 可以個別覆寫）").check();
  await form.getByLabel("Verification 自動重試上限").fill("11");
  await form.getByRole("button", { name: "儲存其他政策" }).click();
  await expect(form.getByText("重試上限必須是 1–10 的整數")).toBeVisible();
  await form.getByLabel("Verification 自動重試上限").fill("5");
  await form.getByLabel("可以分派的 Agent").fill("claude-code, codex");
  await form.getByLabel("會觸發 Feedback Loop 的 bot").fill("coderabbitai[bot]");
  await form.getByRole("button", { name: "儲存其他政策" }).click();

  await page.reload();
  await expect(form.getByLabel("需要 Plan Gate（Task 可以個別覆寫）")).toBeChecked();
  await expect(form.getByLabel("Verification 自動重試上限")).toHaveValue("5");
  await expect(form.getByLabel("可以分派的 Agent")).toHaveValue("claude-code, codex");
  await page.goto("/tasks/ORB-2");
  await expect(planGateButton(page)).toHaveText("沿用專案（開啟）");
});
