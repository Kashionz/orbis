import { DESKTOP_BRIDGE_KEY } from "@orbis/desktop/bridge";
import type { Page } from "@playwright/test";
import { buildStream, STREAM_WINDOW } from "../src/features/run/stream/stream-model";
import { applyEvents, EMPTY_TIMELINE } from "../src/features/run/timeline";
import { LARGE_RUN_ID } from "../src/mocks/backend";
import { generateLargeRun, LARGE_RUN_LAST_MESSAGE } from "../src/mocks/scripts";
import { dispatchTask, expect, permissionRow, stream, test } from "./fixtures";

const dispatch = (page: Page, taskKey: string) => dispatchTask(page, taskKey);

test.describe("Run 工作區的事件串流", () => {
  test("即時顯示事件，在串流中允許權限請求後繼續執行到審查關卡", async ({ page }) => {
    await dispatch(page, "ORB-2");
    await expect(stream(page)).toContainText("我需要寫入 config.json。");
    await expect(page.getByTestId("run-status")).toHaveText("等待權限回覆");
    await expect(permissionRow(page)).toContainText("寫入 config.json");
    // 輸入框上方的 dock 也提示等待回覆
    await expect(page.locator(".cp-dock")).toContainText("等待回覆權限請求");

    await permissionRow(page).getByRole("button", { name: "允許一次" }).click();
    await expect(permissionRow(page)).toContainText("已回覆 允許一次");
    await expect(stream(page)).toContainText("已寫入 config.json。");
    await expect(stream(page)).toContainText("完成了。");
    await expect(page.getByTestId("run-status")).toHaveText("等待審查關卡");
    await expect(page.getByTestId("run-usage")).toHaveAttribute("data-tip", /1\.2k \/ 200\.0k/);
    await expect(page.locator(".cp-dock")).toContainText("審查關卡");
    await expect(page.getByRole("button", { name: "開啟差異審查" })).toBeVisible();

    // 執行結束後才出現尾列
    await expect(page.getByTestId("stream-tail")).toContainText("工作了");

    // 工具群組預設收合；展開後看得到 diff 預覽與終端機輸出
    const group = stream(page).locator(".st-group").filter({ hasText: "修改了程式碼" }).last();
    await group.locator(".st-group-toggle").click();
    const readme = group.locator(".st-tool").filter({ hasText: "README.md" });
    await expect(readme.locator(".st-snippet")).toContainText("已由 Fake Agent 更新。");
    // 成功的指令預設收合，點開才看得到輸出
    await group
      .locator(".st-tool")
      .filter({ hasText: "pnpm test" })
      .locator(".st-tool-toggle")
      .click();
    await expect(group.locator(".st-term")).toContainText("✓ 3 個測試通過");
  });

  test("拒絕權限請求時 Agent 走另一條分支", async ({ page }) => {
    await dispatch(page, "ORB-2");
    await permissionRow(page).getByRole("button", { name: "拒絕" }).click();
    await expect(permissionRow(page)).toContainText("已回覆 拒絕");
    await expect(stream(page)).toContainText("好，我不會修改 config.json。");
    const group = stream(page).locator(".st-group").first();
    await group.locator(".st-group-toggle").click();
    await expect(group.locator(".st-tool-row").filter({ hasText: "config.json" })).toHaveAttribute(
      "data-tool-status",
      "failed",
    );
  });

  test("思考預設收合，可以展開", async ({ page }) => {
    await dispatch(page, "ORB-2");
    const thought = stream(page).locator(".st-thought").first();
    const toggle = thought.locator(".st-thought-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(thought.locator(".st-thought-body")).toHaveCount(0);
    await toggle.click();
    await expect(thought.locator(".st-thought-body")).toHaveText("先看看專案裡有什麼。");
  });

  test("重新整理後從 seq 重播，畫面完全一樣", async ({ page }) => {
    await dispatch(page, "ORB-2");
    await permissionRow(page).getByRole("button", { name: "允許一次" }).click();
    // 回合結束後還有 Verification；等它結束、進入審查關卡後事件才不再增加
    await expect(page.getByTestId("run-status")).toHaveText("等待審查關卡");
    await expect(page.getByTestId("stream-tail")).toBeVisible();

    const snapshot = () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>(".st-item")];
        return {
          rows: rows.map((row) => ({ key: row.dataset.key, text: row.innerText })),
          count: document.querySelector<HTMLElement>("[data-testid=timeline]")?.dataset.itemCount,
          status: document.querySelector("[data-testid=run-status]")?.textContent,
        };
      });
    const before = await snapshot();
    expect(before.rows.length).toBeGreaterThan(5);

    await page.reload();
    await expect(page.getByTestId("run-status")).toHaveText("等待審查關卡");
    await expect(stream(page)).toHaveAttribute("data-item-count", before.count ?? "");
    await expect.poll(snapshot).toEqual(before);
  });

  test("5,000 筆事件用虛擬列表與分段顯示順暢呈現", async ({ page }) => {
    const events = generateLargeRun(LARGE_RUN_ID, 5_000);
    const items = buildStream(applyEvents(EMPTY_TIMELINE, events).items, {
      status: "completed",
      gate: null,
      autoExpandTools: false,
    });

    const started = Date.now();
    await page.goto(`/runs/${LARGE_RUN_ID}`);
    await expect(stream(page)).toHaveAttribute("data-item-count", String(items.length));
    // 自動捲到底，看得到最後一筆
    await expect(stream(page).getByText(LARGE_RUN_LAST_MESSAGE)).toBeVisible();
    const loadMs = Date.now() - started;
    expect(loadMs, `載入 5,000 筆事件花了 ${loadMs}ms`).toBeLessThan(10_000);

    // 只渲染看得到的列
    const rows = stream(page).locator(".st-row");
    expect(await rows.count()).toBeLessThan(80);

    // 一開始只顯示最後一段；「載入較早」每次多顯示一段，直到最上面
    const earlier = stream(page).getByRole("button", { name: /載入較早的/ });
    const presses = Math.ceil(items.length / STREAM_WINDOW) - 1;
    for (let i = 0; i < presses; i += 1) {
      await stream(page).evaluate((el) => {
        el.scrollTop = 0;
      });
      await earlier.click();
    }
    await expect(earlier).toHaveCount(0);

    // 從底部捲到頂部，每一段都有內容（不會出現空白）
    const scrollStarted = Date.now();
    for (let step = 20; step >= 0; step -= 1) {
      await stream(page).evaluate((el, ratio) => {
        el.scrollTop = (el.scrollHeight - el.clientHeight) * ratio;
      }, step / 20);
      await expect.poll(() => rows.count()).toBeGreaterThan(0);
      expect(await rows.count()).toBeLessThan(80);
    }
    const scrollMs = Date.now() - scrollStarted;
    expect(scrollMs, `捲動 21 段花了 ${scrollMs}ms`).toBeLessThan(10_000);
    await expect(stream(page).getByText("工作樹已就緒")).toBeVisible();

    // 捲動中每一格畫面的長任務：沒有超過 200ms 的主執行緒阻塞
    const longestFrame = await stream(page).evaluate(async (el) => {
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

test("中止執行後 Task 回到就緒", async ({ page }) => {
  await dispatch(page, "ORB-2");
  await expect(page.getByTestId("run-status")).toHaveText("等待權限回覆");
  await page.getByRole("button", { name: "中止執行" }).click();
  await expect(page.getByTestId("run-status")).toHaveText("已中止");
  await expect(page.getByRole("button", { name: "中止執行" })).toHaveCount(0);
  await expect(page.locator(".rp-status")).toHaveText("就緒");
  // 中止後可以重新派工
  await page.getByRole("button", { name: "重新派工" }).click();
  await expect(page.getByRole("form", { name: "派工" })).toBeVisible();
});

test.describe("別人在自己電腦上派工的 Run", () => {
  test("只有擁有者能回覆 Local Runner 的權限請求", async ({ page }) => {
    await dispatch(page, "ORB-2");
    await expect(permissionRow(page).getByRole("button", { name: "允許一次" })).toBeVisible();
    // 把 Run 改成別人派工的，模擬其他 Member 看到的畫面
    await page.evaluate(() => {
      const key = "mock-backend-state";
      const state = JSON.parse(sessionStorage.getItem(key) ?? "{}");
      for (const run of state.runs) run.startedByMemberId = "member-alice";
      sessionStorage.setItem(key, JSON.stringify(state));
    });
    await page.reload();
    await expect(permissionRow(page)).toContainText("等待有權限的成員回覆");
    await expect(permissionRow(page).locator(".st-option")).toHaveCount(0);
  });
});

test.describe("Worktree 路徑選單", () => {
  test("一般瀏覽器中只能複製，在終端機開啟改為切到終端機分頁", async ({ page }) => {
    await page.goto("/tasks/ORB-3");
    await expect(stream(page)).toContainText("工作樹已就緒");
    await page.getByRole("button", { name: /^工作樹/ }).click();
    const menu = page.getByRole("menu", { name: "工作樹" });
    await expect(menu.getByRole("menuitem", { name: "在 VS Code 開啟" })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "在檔案總管開啟" })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "在終端機開啟" }).click();
    await expect(page.getByRole("tab", { name: "終端機" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("有 bridge 時以 Run 的 Worktree 路徑開啟，失敗時顯示 message", async ({ page }) => {
    await page.addInitScript((key) => {
      const calls: string[] = [];
      Object.assign(window, { __bridgeCalls: calls });
      Object.assign(window, {
        [key]: {
          getVersion: async () => "0.0.0",
          openWorktreeInEditor: async (path: string) => {
            calls.push(`editor:${path}`);
            return { ok: true };
          },
          openWorktreeInTerminal: async (path: string) => {
            calls.push(`terminal:${path}`);
            return { ok: false, message: "找不到設定的終端機" };
          },
          beforeLogout: async () => ({ proceed: true }),
        },
      });
    }, DESKTOP_BRIDGE_KEY);
    await page.goto("/tasks/ORB-3");
    const open = async (name: string) => {
      await page.getByRole("button", { name: /^工作樹/ }).click();
      await page.getByRole("menu", { name: "工作樹" }).getByRole("menuitem", { name }).click();
    };
    await open("在 VS Code 開啟");
    await open("在終端機開啟");
    await expect(page.getByText("找不到設定的終端機")).toBeVisible();
    // TODO(backend, reveal-in-explorer)：bridge 還沒有在檔案總管開啟，項目停用
    await page.getByRole("button", { name: /^工作樹/ }).click();
    await expect(
      page.getByRole("menu", { name: "工作樹" }).getByRole("menuitem", { name: "在檔案總管開啟" }),
    ).toHaveAttribute("aria-disabled", "true");
    const calls = await page.evaluate(
      () => (window as unknown as { __bridgeCalls: string[] }).__bridgeCalls,
    );
    expect(calls).toEqual(["editor:C:/wt/demo/run", "terminal:C:/wt/demo/run"]);
  });
});
