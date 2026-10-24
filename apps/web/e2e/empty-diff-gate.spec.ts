// Review Gate 的 diff 為空（#73）：不能核准並開 PR，改為結束（沒有變更）或退回，並顯示 Agent 最後的回覆。

import type { Page } from "@playwright/test";
import type { MockState } from "../src/mocks/backend";
import { MODEL_ERROR_REPLY } from "../src/mocks/scripts";
import { expect, mockState, test } from "./fixtures";

/** mock 設定 `emptyDiff` 建立的 Task（Agent 沒有改檔，最後的回覆是模型錯誤）。 */
const EMPTY_TASK_TITLE = "回答：登入頁需要修改嗎？";

/** 打開 diff 為空的 Run 的 diff review，回傳 Run 與 Task 的 key。 */
async function openEmptyReview(page: Page): Promise<{ runId: string; taskKey: string }> {
  await page.goto("/needs-you");
  await expect(page.getByRole("link", { name: "前往 diff review" }).first()).toBeVisible();
  const state = await mockState<MockState>(page);
  const task = state.tasks.find((t) => t.title === EMPTY_TASK_TITLE);
  const run = state.runs.find((r) => r.taskId === task?.id);
  if (!task || !run) throw new Error("找不到 diff 為空的 Run");
  await page.goto(`/runs/${run.id}/review`);
  await expect(page.getByRole("heading", { name: "Diff review" })).toBeVisible();
  return { runId: run.id, taskKey: task.key };
}

test.describe("Review Gate 的 diff 為空", () => {
  test.use({ mock: { eventIntervalMs: 20, emptyDiff: true } });

  test("顯示說明與 Agent 最後的回覆，結束（沒有變更）後 Task 轉 Done", async ({ page }) => {
    const { runId, taskKey } = await openEmptyReview(page);
    await expect(page.locator(".file-list")).toContainText("沒有變更");
    const empty = page.getByRole("region", { name: "這一版沒有任何檔案變更" });
    await expect(empty.getByRole("note")).toContainText("不能核准並開 PR");
    await expect(empty.getByTestId("final-message")).toHaveText(MODEL_ERROR_REPLY);
    await expect(page.getByRole("button", { name: "核准並開 PR" })).toHaveCount(0);

    await page.getByRole("button", { name: "結束（沒有變更）" }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
    const state = await mockState<MockState>(page);
    expect(state.reviews[runId]).toEqual([{ action: "finish_without_changes" }]);
    expect(state.gates.find((g) => g.runId === runId)).toMatchObject({
      decision: "approved",
      finishedWithoutChanges: true,
    });

    await page.goto(`/tasks/${taskKey}`);
    await expect(page.locator(".page-header .status-badge")).toHaveText("Done");
    await expect(page.locator(".page-header .done-reason")).toHaveText("已完成");

    // 之後再打開 diff review：只能檢視，並說明已結束（沒有變更）
    await page.goto(`/runs/${runId}/review`);
    await expect(page.getByText("這個 Review Gate 已結束（沒有變更）")).toBeVisible();
    await expect(page.getByRole("button", { name: "結束（沒有變更）" })).toHaveCount(0);
  });

  test("寫整體說明後退回，Agent 在同一個 session 繼續", async ({ page }) => {
    const { runId, taskKey } = await openEmptyReview(page);
    await page.getByLabel("整體說明（選填）").fill("模型不支援，請改用預設的模型再試一次");
    await page.getByRole("button", { name: /退回並附上留言/ }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
    const state = await mockState<MockState>(page);
    expect(state.reviews[runId]).toEqual([
      {
        action: "reject",
        comment: "模型不支援，請改用預設的模型再試一次",
        reviewComments: [],
        previewComments: [],
      },
    ]);
    // 退回後 mock 的 Agent 很快又會跑完下一個回合，所以檢查 Gate 的決定而不是 Task 當下的狀態
    expect(state.gates.find((g) => g.runId === runId)).toMatchObject({
      decision: "rejected",
      finishedWithoutChanges: false,
    });
    expect(state.tasks.find((t) => t.key === taskKey)?.status).not.toBe("done");
  });

  test("有變更的 Review Gate 照常核准並開 PR，不顯示空 diff 的說明", async ({ page }) => {
    await page.goto("/needs-you");
    await page
      .locator(".needs-you-item")
      .filter({ hasText: "ORB-4" })
      .getByRole("link", { name: "前往 diff review" })
      .click();
    await expect(page.getByTestId("diff-editor")).toBeVisible();
    await expect(page.getByRole("region", { name: "這一版沒有任何檔案變更" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "核准並開 PR" })).toBeVisible();
  });
});
