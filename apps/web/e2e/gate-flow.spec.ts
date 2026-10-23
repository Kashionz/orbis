// C2 的完成條件：Plan Gate → Verification 失敗後重試 → 通過 → manual 條件打勾 → 核准（MSW 假後端）。
// 真實 Server + Runner + Fake Agent 的版本在 e2e/system/gate-flow.spec.ts。

import { allowPermission, dispatchTask, expect, test } from "./fixtures";

test.use({
  mock: { eventIntervalMs: 20, verificationFailures: 1, policy: { planGateEnabled: true } },
});

test("Plan Gate → Verification 失敗後重試 → 通過 → manual 打勾 → 核准", async ({ page }) => {
  await dispatchTask(page, "ORB-2");
  const timeline = page.getByTestId("timeline");

  // Plan Gate：核准 plan
  const plan = page.getByRole("region", { name: "Plan Gate：等待核准 plan" });
  await expect(plan.getByTestId("plan-body")).toContainText("新增 hello.txt");
  await plan.getByRole("button", { name: "核准 plan" }).click();
  await expect(plan).toHaveCount(0);

  // Running：回覆權限請求，回合結束後開始 Verification
  await allowPermission(page);
  await expect(timeline).toContainText("完成了。");

  // Verification 第一輪失敗、自動重試、第二輪通過
  await expect(timeline).toContainText("第 1 輪 Verification 結束：失敗");
  await expect(timeline).toContainText("送出 prompt（Verification 重試）");
  await expect(timeline).toContainText("第 2 輪 Verification 結束：通過");
  await page.getByRole("tab", { name: "Verification" }).click();
  await expect(
    page.getByTestId("verification-2").locator(".verification-header .status-badge"),
  ).toHaveText("通過");

  // Review Gate：manual 條件打勾後才能核准
  await page.getByRole("link", { name: "Diff review" }).click();
  const approve = page.getByRole("button", { name: "核准並開 PR" });
  await expect(approve).toBeDisabled();
  const criteria = page.getByRole("region", { name: "Acceptance Criterion" });
  await expect(criteria.locator('li[data-kind="command"]')).toContainText("通過");
  await criteria.getByRole("checkbox", { name: "README 文字通順" }).check();
  await approve.click();

  await expect(page.getByTestId("run-status")).toHaveText("已完成");
  await page.goto("/board");
  await expect(page.locator('[data-status="pr_open"] [data-task-key="ORB-2"]')).toBeVisible();
});
