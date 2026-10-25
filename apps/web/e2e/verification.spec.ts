// Verification 結果（#41）：逐條顯示結果與證據、重試次數；超過重試上限時由人決定。

import { API_ROUTES, apiPath, type Task } from "@orbis/api-contract";
import type { Page } from "@playwright/test";
import { allowPermission, apiCall, dispatchTask, expect, test } from "./fixtures";

const timeline = (page: Page) => page.getByTestId("timeline");

async function openVerificationTab(page: Page) {
  await page.getByRole("tab", { name: "Verification" }).click();
  return page.getByRole("region", { name: "Verification 結果" });
}

test.describe("失敗一次後自動重試", () => {
  test.use({ mock: { eventIntervalMs: 20, verificationFailures: 1 } });

  test("第一輪失敗，Server 自動送回 Agent 修正，第二輪通過後進入 Review Gate", async ({ page }) => {
    await dispatchTask(page, "ORB-2");
    await allowPermission(page);
    await expect(timeline(page)).toContainText("第 1 輪 Verification 結束：失敗");
    await expect(timeline(page)).toContainText("送出 prompt（驗收重試）");
    await expect(timeline(page)).toContainText("依 Verification 的失敗原因修正。");
    await expect(timeline(page)).toContainText("第 2 輪 Verification 結束：通過");
    await expect(page.getByRole("link", { name: "Diff review" })).toBeVisible();

    const panel = await openVerificationTab(page);
    const first = panel.getByTestId("verification-1");
    const second = panel.getByTestId("verification-2");
    await expect(first.locator(".verification-header .status-badge")).toHaveText("失敗");
    await expect(second.locator(".verification-header .status-badge")).toHaveText("通過");
    await expect(second).toContainText("已自動重試 1 次／上限 3 次");
    const failed = first.locator('.verification-result[data-outcome="failed"]');
    await expect(failed).toContainText("測試通過");
    await expect(failed).toContainText("pnpm test 失敗：exit code 1");
    await expect(failed.locator('[data-evidence="command_output"]')).toContainText(
      "✗ 1 個測試失敗",
    );
    await expect(failed.locator('[data-evidence="command_output"]')).toContainText("exit code 1");
  });
});

test("agent 與 browser 條件的證據：判定理由、判定 Run、截圖與操作紀錄", async ({ page }) => {
  await page.goto("/tasks/ORB-2");
  const task = (await apiCall(
    page,
    "GET",
    apiPath(API_ROUTES.taskByKey, { taskKey: "ORB-2" }),
  )) as Task;
  const criteria = apiPath(API_ROUTES.taskAcceptanceCriteria, { taskId: task.id });
  await apiCall(page, "POST", criteria, { kind: "agent", description: "符合 Spec" });
  await apiCall(page, "POST", criteria, { kind: "browser", description: "首頁顯示歡迎訊息" });

  await dispatchTask(page, "ORB-2");
  await allowPermission(page);
  await expect(page.getByRole("link", { name: "Diff review" })).toBeVisible();
  const panel = await openVerificationTab(page);
  const agent = panel.locator(".verification-result", { hasText: "符合 Spec" });
  await expect(agent.locator('[data-evidence="text"]')).toHaveText(
    "Agent 判定：diff 符合 Spec 的描述。",
  );
  await expect(agent.getByRole("link", { name: "判定的 Agent Run" })).toBeVisible();
  const browser = panel.locator(".verification-result", { hasText: "首頁顯示歡迎訊息" });
  const image = browser.locator('[data-evidence="screenshot"] img');
  await expect(image).toHaveAttribute("alt", "首頁");
  await expect
    .poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect(browser.locator('[data-evidence="action_log"] li')).toHaveText([
    "開啟首頁",
    "點擊「開始」",
    "看到歡迎訊息",
  ]);

  // 判定的 consult Run 標示來源
  await agent.getByRole("link", { name: "判定的 Agent Run" }).click();
  await expect(page.locator(".run-meta")).toContainText("驗收");
  await expect(page.locator(".run-meta")).toContainText("諮詢（唯讀）");
});

test.describe("超過重試上限", () => {
  test.use({
    mock: { eventIntervalMs: 20, verificationFailures: 99, policy: { verificationMaxRetries: 1 } },
  });

  async function untilAwaitingDecision(page: Page) {
    const panel = await openVerificationTab(page);
    const form = panel.getByRole("form", { name: "Verification 的決定" });
    await expect(form).toBeVisible();
    return { panel, form };
  }

  test("停在 Verifying 並加入 Needs You；附意見再試時重試次數重新計算", async ({ page }) => {
    await dispatchTask(page, "ORB-2");
    await allowPermission(page);
    await expect(timeline(page)).toContainText("第 2 輪 Verification 結束：失敗");
    const { panel, form } = await untilAwaitingDecision(page);
    await expect(form).toContainText("Verification 連續失敗 2 輪，超過重試上限");
    await expect(page.getByRole("link", { name: "Diff review" })).toHaveCount(0);

    await form.getByLabel("給 Agent 的意見（選填）").fill("請先跑 pnpm install");
    await form.getByRole("button", { name: "附意見再試" }).click();
    await expect(form).toHaveCount(0);
    await expect(panel.getByTestId("verification-2").first()).toContainText("人的決定：附意見再試");
    await expect(panel.getByTestId("verification-2").first()).toContainText(
      "意見：請先跑 pnpm install",
    );
    // 新的一輪從 1 開始
    await expect(panel.getByTestId("verification-1")).toHaveCount(2);
    await expect(panel.getByRole("form", { name: "Verification 的決定" })).toBeVisible();

    // Needs You 的「Run 已停下」：「前往 Run」直接開 Verification 分頁，決定的表單就在眼前
    await page.goto("/needs-you");
    const stopped = page.locator('.needs-you-item[data-kind="stopped_run"]');
    await expect(stopped).toContainText("超過重試上限");
    await stopped.getByRole("link", { name: "前往 Run" }).click();
    await expect(page).toHaveURL(/\/runs\/run-\d+\?tab=verification$/);
    await expect(page.getByRole("tab", { name: "Verification" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("form", { name: "Verification 的決定" })).toBeVisible();
  });

  test("略過失敗進入 Review Gate：Review 頁看得到失敗，manual 全部打勾才能核准", async ({
    page,
  }) => {
    await dispatchTask(page, "ORB-2");
    await allowPermission(page);
    const { form } = await untilAwaitingDecision(page);
    await form.getByRole("button", { name: "略過失敗，進入 Review Gate" }).click();
    await page.getByRole("link", { name: "Diff review" }).click();

    const criteria = page.getByRole("region", { name: "Acceptance Criterion" });
    await expect(criteria.getByRole("note")).toContainText("已選擇略過");
    await expect(criteria.locator('li[data-kind="command"]')).toContainText("失敗");
    const approve = page.getByRole("button", { name: "核准並開 PR" });
    await expect(approve).toBeDisabled();
    await expect(page.getByText("還有 1 條 manual 條件沒有打勾")).toBeVisible();
    await criteria.getByRole("checkbox", { name: "README 文字通順" }).check();
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(page.getByTestId("run-status")).toHaveText("已完成");
  });

  test("選擇中止時 Run 結束，Task 回到 Ready", async ({ page }) => {
    await dispatchTask(page, "ORB-2");
    await allowPermission(page);
    const { form } = await untilAwaitingDecision(page);
    await form.getByRole("button", { name: "中止 Run" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("已中止");
    await page.getByRole("link", { name: /ORB-2/ }).click();
    await expect(page.locator(".page-header .status-badge")).toHaveText("就緒");
  });
});
