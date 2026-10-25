// Verification 結果（#41）：事件串流的驗收群組、任務分頁的驗收紀錄逐輪逐條顯示結果與證據、重試次數；
// 超過重試上限時由人決定。

import { API_ROUTES, apiPath, type Task } from "@orbis/api-contract";
import type { Page } from "@playwright/test";
import { allowPermission, apiCall, dispatchTask, expect, stream, test } from "./fixtures";

/** 任務分頁的驗收紀錄。 */
function history(page: Page) {
  return page.getByTestId("verification-section");
}

async function openRound(page: Page, attempt: number, nth = 0) {
  const round = history(page).getByTestId(`verification-${attempt}`).nth(nth);
  const head = round.locator(".rp-round-head");
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  return round;
}

test.describe("失敗一次後自動重試", () => {
  test.use({ mock: { eventIntervalMs: 20, verificationFailures: 1 } });

  test("第一輪失敗，Server 自動送回 Agent 修正，第二輪通過後進入審查關卡", async ({ page }) => {
    await dispatchTask(page, "ORB-2");
    await allowPermission(page);
    await expect(stream(page).locator(".st-verify")).toHaveCount(2);
    await expect(stream(page)).toContainText("驗收重試");
    await expect(stream(page)).toContainText("依 Verification 的失敗原因修正。");
    await expect(page.getByRole("button", { name: "開啟差異審查" })).toBeVisible();

    const first = await openRound(page, 1);
    const second = history(page).getByTestId("verification-2");
    await expect(first.locator(".rp-round-status")).toHaveText("失敗");
    await expect(second.locator(".rp-round-status")).toHaveText("通過");
    await expect(second).toContainText("已自動重試 1 次／上限 3 次");
    const failed = first.locator('.rp-result[data-outcome="failed"]');
    await expect(failed).toContainText("測試通過");
    await expect(failed).toContainText("pnpm test 失敗：exit code 1");
    await expect(failed.locator('[data-evidence="command_output"]')).toContainText(
      "✗ 1 個測試失敗",
    );
    await expect(failed.locator('[data-evidence="command_output"]')).toContainText("結束碼 1");
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
  await expect(page.getByRole("button", { name: "開啟差異審查" })).toBeVisible();
  const round = await openRound(page, 1);
  const agent = round.locator(".rp-result", { hasText: "符合 Spec" });
  await expect(agent.locator('[data-evidence="text"]')).toHaveText(
    "Agent 判定：diff 符合 Spec 的描述。",
  );
  await expect(agent.getByRole("link", { name: "判定的執行" })).toBeVisible();
  const browser = round.locator(".rp-result", { hasText: "首頁顯示歡迎訊息" });
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
  await agent.getByRole("link", { name: "判定的執行" }).click();
  await expect(page.getByTestId("run-origin")).toContainText("驗收");
  await expect(page.getByTestId("run-origin")).toContainText("諮詢（唯讀）");
});

test.describe("超過重試上限", () => {
  test.use({
    mock: { eventIntervalMs: 20, verificationFailures: 99, policy: { verificationMaxRetries: 1 } },
  });

  const decision = (page: Page) =>
    history(page).getByRole("form", { name: /驗收連續失敗 \d+ 輪，超過重試上限/ });

  test("停在驗證並加入待我處理；附意見再試時重試次數重新計算", async ({ page }) => {
    await dispatchTask(page, "ORB-2");
    await allowPermission(page);
    await expect(decision(page)).toBeVisible();
    await expect(decision(page)).toContainText("驗收連續失敗 2 輪，超過重試上限");
    await expect(page.locator(".cp-dock")).toContainText("驗收未通過");
    await expect(page.getByRole("button", { name: "開啟差異審查" })).toHaveCount(0);

    await decision(page).getByLabel("給代理的意見（選填）").fill("請先跑 pnpm install");
    await decision(page).getByRole("button", { name: "附意見再試" }).click();
    const decided = history(page).getByTestId("verification-2").first();
    await expect(decided).toContainText("決定：附意見再試");
    await expect(decided).toContainText("意見：請先跑 pnpm install");
    // 新的一輪從 1 開始
    await expect(history(page).getByTestId("verification-1")).toHaveCount(2);
    await expect(decision(page)).toBeVisible();

    // 待我處理的「停下來的執行」：直接開任務分頁的驗收紀錄，決定的表單就在眼前
    await page.goto("/needs-you");
    const stopped = page.locator('.ny-row[data-kind="stopped_run"]');
    await expect(stopped).toContainText("超過重試上限");
    await stopped.getByRole("button", { name: "前往決定" }).click();
    await expect(page).toHaveURL(/\/tasks\/ORB-2\?run=run-\d+&tab=task&focus=verification$/);
    await expect(page.getByRole("tab", { name: "任務" })).toHaveAttribute("aria-selected", "true");
    await expect(decision(page)).toBeInViewport();
  });

  test("Desktop 通知的 ?tab=verification 深連結開啟驗收紀錄", async ({ page }) => {
    await dispatchTask(page, "ORB-2");
    await allowPermission(page);
    await expect(decision(page)).toBeVisible();
    const runId = new URL(page.url()).searchParams.get("run") ?? "";
    await page.goto(`/runs/${runId}?tab=verification`);
    await expect(page.getByRole("tab", { name: "任務" })).toHaveAttribute("aria-selected", "true");
    await expect(decision(page)).toBeInViewport();
  });

  test("略過失敗進入審查關卡：看得到失敗，人工確認全部打勾才能核准", async ({ page }) => {
    await dispatchTask(page, "ORB-2");
    await allowPermission(page);
    await decision(page).getByRole("button", { name: "略過失敗，進入審查關卡" }).click();
    await page.getByRole("button", { name: "開啟差異審查" }).click();

    await expect(page.getByRole("note").filter({ hasText: "已選擇略過" })).toBeVisible();
    const approve = page.getByRole("button", { name: "核准並開啟合併請求" });
    await expect(approve).toBeDisabled();
    await expect(page.getByText("還有 1 條人工確認的條件沒有打勾")).toBeVisible();
    await page.getByRole("checkbox", { name: "README 文字通順" }).check();
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(page.getByTestId("run-status")).toHaveText("已完成");
    // 任務分頁的驗收條件看得到失敗的結果
    await page.getByRole("tab", { name: "任務" }).click();
    await expect(page.locator('.rp-criterion[data-kind="command"]')).toContainText("失敗");
  });

  test("選擇中止時執行結束，Task 回到就緒", async ({ page }) => {
    await dispatchTask(page, "ORB-2");
    await allowPermission(page);
    await decision(page).getByRole("button", { name: "中止執行" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("已中止");
    await expect(page.locator(".rp-status")).toHaveText("就緒");
  });
});
