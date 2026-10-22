import type { Page } from "@playwright/test";
import { applyEvents, EMPTY_TIMELINE } from "../src/features/run/timeline";
import { LARGE_RUN_ID } from "../src/mocks/backend";
import { generateLargeRun, LARGE_RUN_LAST_MESSAGE } from "../src/mocks/scripts";
import { expect, test } from "./fixtures";

/** 從 Task 頁派工（預設選項），回到 Run 頁。 */
async function dispatch(page: Page, taskKey: string) {
  await page.goto(`/tasks/${taskKey}`);
  await page.getByRole("button", { name: "派工" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "派工" }).click();
  await expect(page).toHaveURL(/\/runs\/run-\d+$/);
}

const timeline = (page: Page) => page.getByTestId("timeline");
const permission = (page: Page) => timeline(page).locator(".event-permission");

test.describe("Run 即時檢視", () => {
  test("即時顯示 Event，在列表中允許權限請求後繼續執行到 Review Gate", async ({ page }) => {
    await dispatch(page, "ORB-2");
    await expect(timeline(page)).toContainText("我需要寫入 config.json。");
    await expect(page.getByTestId("run-status")).toHaveText("等待權限回覆");
    await expect(permission(page)).toContainText("寫入 config.json");

    await permission(page).getByRole("button", { name: "允許" }).click();
    await expect(permission(page)).toContainText("已回覆：允許");
    await expect(timeline(page)).toContainText("已寫入 config.json。");
    await expect(timeline(page)).toContainText("完成了。");
    await expect(page.getByTestId("run-status")).toHaveText("等待 Gate");
    await expect(page.getByTestId("run-usage")).toContainText("context 1,200 / 200,000");
    await expect(page.getByRole("link", { name: "Diff review" })).toBeVisible();

    // tool call 的 diff 預覽與 terminal 輸出
    const readme = timeline(page).locator(".event-tool-call", { hasText: "編輯 README.md" });
    await expect(readme.locator(".diff-add")).toContainText(["+已由 Fake Agent 更新。"]);
    await expect(readme).toContainText("完成");
    await expect(timeline(page).locator(".terminal")).toContainText("✓ 3 個測試通過");
  });

  test("拒絕權限請求時 Agent 走另一條分支", async ({ page }) => {
    await dispatch(page, "ORB-2");
    await permission(page).getByRole("button", { name: "拒絕" }).click();
    await expect(permission(page)).toContainText("已回覆：拒絕");
    await expect(timeline(page)).toContainText("好，我不會修改 config.json。");
    const call = timeline(page).locator(".event-tool-call", { hasText: "寫入 config.json" });
    await expect(call).toHaveAttribute("data-tool-status", "failed");
  });

  test("思考預設收合，可以展開", async ({ page }) => {
    await dispatch(page, "ORB-2");
    const thought = timeline(page).locator(".event-thought");
    const toggle = thought.getByRole("button", { name: /思考/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(thought.locator(".thought-text")).toHaveCount(0);
    await toggle.click();
    await expect(thought.locator(".thought-text")).toHaveText("先看看專案裡有什麼。");
  });

  test("重新整理後從 seq 重播，畫面完全一樣", async ({ page }) => {
    await dispatch(page, "ORB-2");
    await permission(page).getByRole("button", { name: "允許" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("等待 Gate");

    const snapshot = () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>(".timeline-row")];
        return {
          rows: rows.map((row) => ({ key: row.dataset.key, text: row.innerText })),
          count: document.querySelector<HTMLElement>("[data-testid=timeline]")?.dataset.itemCount,
          status: document.querySelector("[data-testid=run-status]")?.textContent,
          usage: document.querySelector("[data-testid=run-usage]")?.textContent,
        };
      });
    const before = await snapshot();
    expect(before.rows.length).toBeGreaterThan(5);

    await page.reload();
    await expect(page.getByTestId("run-status")).toHaveText("等待 Gate");
    await expect(timeline(page)).toHaveAttribute("data-item-count", before.count ?? "");
    await expect.poll(snapshot).toEqual(before);
  });

  test("5,000 筆 Event 用虛擬列表順暢顯示", async ({ page }) => {
    const events = generateLargeRun(LARGE_RUN_ID, 5_000);
    const itemCount = applyEvents(EMPTY_TIMELINE, events).items.length;

    const started = Date.now();
    await page.goto(`/runs/${LARGE_RUN_ID}`);
    await expect(timeline(page)).toHaveAttribute("data-item-count", String(itemCount));
    // 自動捲到底，看得到最後一筆
    await expect(timeline(page).getByText(LARGE_RUN_LAST_MESSAGE)).toBeVisible();
    const loadMs = Date.now() - started;
    expect(loadMs, `載入 5,000 筆 Event 花了 ${loadMs}ms`).toBeLessThan(10_000);

    // 只渲染看得到的列
    const rows = timeline(page).locator(".timeline-row");
    expect(await rows.count()).toBeLessThan(80);

    // 從底部捲到頂部，每一段都有內容（不會出現空白）
    const scrollStarted = Date.now();
    for (let step = 20; step >= 0; step -= 1) {
      await timeline(page).evaluate((el, ratio) => {
        el.scrollTop = (el.scrollHeight - el.clientHeight) * ratio;
      }, step / 20);
      await expect.poll(() => rows.count()).toBeGreaterThan(0);
      expect(await rows.count()).toBeLessThan(80);
    }
    const scrollMs = Date.now() - scrollStarted;
    expect(scrollMs, `捲動 21 段花了 ${scrollMs}ms`).toBeLessThan(10_000);
    await expect(timeline(page).getByText("Worktree 已就緒")).toBeVisible();

    // 捲動中每一格畫面的長任務：沒有超過 200ms 的主執行緒阻塞
    const longestFrame = await timeline(page).evaluate(async (el) => {
      let longest = 0;
      let last = performance.now();
      for (let i = 0; i < 60; i += 1) {
        el.scrollTop += el.clientHeight;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
      }
      return longest;
    });
    expect(longestFrame, `最長的一格畫面 ${longestFrame.toFixed(0)}ms`).toBeLessThan(200);
  });
});

test("中止 Run 後 Task 回到 Ready", async ({ page }) => {
  await dispatch(page, "ORB-2");
  await expect(page.getByTestId("run-status")).toHaveText("等待權限回覆");
  await page.getByRole("button", { name: "中止 Run" }).click();
  await expect(page.getByTestId("run-status")).toHaveText("已中止");
  await expect(page.getByRole("button", { name: "中止 Run" })).toHaveCount(0);
  await page.getByRole("link", { name: /ORB-2/ }).click();
  await expect(page.locator(".page-header .status-badge")).toHaveText("Ready");
});

test.describe("別人在自己電腦上派工的 Run", () => {
  test("只有擁有者能回覆 Local Runner 的權限請求", async ({ page }) => {
    await dispatch(page, "ORB-2");
    await expect(permission(page).getByRole("button", { name: "允許" })).toBeVisible();
    // 把 Run 改成別人派工的，模擬其他 Member 看到的畫面
    await page.evaluate(() => {
      const key = "mock-backend-state";
      const state = JSON.parse(sessionStorage.getItem(key) ?? "{}");
      for (const run of state.runs) run.startedByMemberId = "member-alice";
      sessionStorage.setItem(key, JSON.stringify(state));
    });
    await page.reload();
    await expect(permission(page)).toContainText("等待有權限的 Member 回覆");
    await expect(permission(page).getByRole("button")).toHaveCount(0);
  });
});
