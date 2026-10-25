// Plan Gate（#41）：Run 頁顯示 plan，核准或退回並附上意見；Project 與 Task 層級的開關。

import { dispatchTask, expect, test } from "./fixtures";

const planPanel = (page: import("@playwright/test").Page) =>
  page.getByRole("region", { name: "Plan Gate：等待核准 plan" });

test.describe("Plan Gate 開啟時", () => {
  test.use({ mock: { eventIntervalMs: 20, policy: { planGateEnabled: true } } });

  test("顯示 plan；退回並附上意見後 Agent 修訂 plan，核准後開始實作", async ({ page }) => {
    await dispatchTask(page, "ORB-2");
    const panel = planPanel(page);
    await expect(panel.getByTestId("plan-body").getByRole("heading")).toHaveText("Plan");
    await expect(panel.getByTestId("plan-body")).toContainText("新增 hello.txt");
    await expect(panel).toContainText("來源：計畫模式");

    // 退回一定要附意見
    const reject = panel.getByRole("button", { name: "退回並附上意見" });
    await expect(reject).toBeDisabled();
    await panel.getByLabel("退回的意見").fill("請補上測試");
    await reject.click();
    await expect(panel.getByTestId("plan-body").getByRole("heading")).toHaveText("Plan（修訂）");
    await expect(panel.getByTestId("plan-body")).toContainText("補上測試");
    await expect(page.getByTestId("timeline")).toContainText("送出 prompt（計畫關卡退回）");

    await panel.getByRole("button", { name: "核准 plan" }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId("timeline")).toContainText("我需要寫入 config.json。");
    await page.getByRole("link", { name: /ORB-2/ }).click();
    await expect(page.locator(".page-header .status-badge")).toHaveText("執行中");
  });

  test("等待 Plan Gate 時 Task 在 Plan Gate 欄，Needs You 也列出", async ({ page }) => {
    await dispatchTask(page, "ORB-2");
    await expect(planPanel(page)).toBeVisible();
    await page.goto("/board");
    await expect(page.locator('[data-status="plan_gate"] [data-task-key="ORB-2"]')).toBeVisible();
    await page.goto("/needs-you");
    await expect(page.locator("main")).toContainText("ORB-2");
  });

  test("在 Plan Gate 中止 Run，Task 回到 Ready", async ({ page }) => {
    await dispatchTask(page, "ORB-2");
    await planPanel(page).getByRole("button", { name: "中止 Run" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("已中止");
    await page.getByRole("link", { name: /ORB-2/ }).click();
    await expect(page.locator(".page-header .status-badge")).toHaveText("就緒");
  });

  test("Task 可以個別關閉 Plan Gate", async ({ page }) => {
    await page.goto("/tasks/ORB-2");
    await expect(page.getByLabel("Plan Gate")).toHaveValue("inherit");
    await expect(page.getByLabel("Plan Gate").locator("option:checked")).toHaveText(
      "沿用 Project（開啟）",
    );
    await page.getByLabel("Plan Gate").selectOption("off");
    await dispatchTask(page, "ORB-2");
    await expect(page.getByTestId("timeline")).toContainText("我需要寫入 config.json。");
    await expect(planPanel(page)).toHaveCount(0);
  });
});

test("Plan Gate 關閉的 Project 中，Task 可以個別開啟", async ({ page }) => {
  await page.goto("/tasks/ORB-2");
  await page.getByLabel("Plan Gate").selectOption("on");
  await dispatchTask(page, "ORB-2");
  await expect(planPanel(page)).toBeVisible();
});

test("Project 設定頁可以開啟 Plan Gate 與修改其他政策", async ({ page }) => {
  await page.goto("/projects/project-1/settings");
  const form = page.getByRole("form", { name: "其他政策" });
  await form.getByLabel("需要計畫關卡（任務可以個別覆寫）").check();
  await form.getByLabel("驗收自動重試上限").fill("11");
  await form.getByRole("button", { name: "儲存其他政策" }).click();
  await expect(form.getByText("重試上限必須是 1–10 的整數")).toBeVisible();
  await form.getByLabel("驗收自動重試上限").fill("5");
  await form.getByLabel("可以委派的代理").fill("claude-code, codex");
  await form.getByLabel("會觸發回饋循環的機器人帳號").fill("coderabbitai[bot]");
  await form.getByRole("button", { name: "儲存其他政策" }).click();

  await page.reload();
  await expect(form.getByLabel("需要計畫關卡（任務可以個別覆寫）")).toBeChecked();
  await expect(form.getByLabel("驗收自動重試上限")).toHaveValue("5");
  await expect(form.getByLabel("可以委派的代理")).toHaveValue("claude-code, codex");
  await page.goto("/tasks/ORB-2");
  await expect(page.getByLabel("Plan Gate").locator("option:checked")).toHaveText(
    "沿用 Project（開啟）",
  );
});
