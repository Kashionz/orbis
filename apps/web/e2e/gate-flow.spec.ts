// C2 的完成條件：Plan Gate → Verification 失敗後重試 → 通過 → manual 條件打勾 → 核准（MSW 假後端）。
// 真實 Server + Runner + Fake Agent 的版本在 e2e/system/gate-flow.spec.ts。

import { allowPermission, dispatchTask, expect, stream, test } from "./fixtures";

test.use({
  mock: { eventIntervalMs: 20, verificationFailures: 1, policy: { planGateEnabled: true } },
});

test("Plan Gate → Verification 失敗後重試 → 通過 → manual 打勾 → 核准", async ({ page }) => {
  await dispatchTask(page, "ORB-2");

  // 計畫關卡：在 dock 核准計畫
  await expect(stream(page).locator('.st-plan[data-pending="true"]')).toContainText(
    "新增 hello.txt",
  );
  await page.getByRole("button", { name: "核准計畫" }).click();
  await expect(stream(page).locator('.st-plan[data-pending="true"]')).toHaveCount(0);

  // 執行中：回覆權限請求，回合結束後開始驗收
  await allowPermission(page);
  await expect(stream(page)).toContainText("完成了。");

  // 驗收第一輪失敗（群組自動展開）、自動重試、第二輪通過
  const rounds = stream(page).locator(".st-verify");
  await expect(rounds).toHaveCount(2);
  await expect(rounds.nth(0).locator(".st-row-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(rounds.nth(0).locator(".st-glyph").first()).toHaveText("✕");
  await expect(stream(page)).toContainText("驗收重試");
  await expect(rounds.nth(1).locator(".st-glyph").first()).toHaveText("✓");
  await expect(page.getByTestId("verification-2").locator(".rp-round-status")).toHaveText("通過");

  // 審查關卡：人工確認的條件打勾後才能核准
  await page.getByRole("button", { name: "開啟差異審查" }).click();
  const approve = page.getByRole("button", { name: "核准並開啟合併請求" });
  await expect(approve).toBeDisabled();
  await page.getByRole("checkbox", { name: "README 文字通順" }).check();
  await approve.click();

  await expect(page.getByTestId("run-status")).toHaveText("已完成");
  await page.goto("/board");
  await expect(page.locator('[data-status="pr_open"] [data-task-key="ORB-2"]')).toBeVisible();
});
