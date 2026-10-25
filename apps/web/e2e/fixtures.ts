// mock 模式 e2e 的共用工具：在頁面載入前設定 MSW 假後端（src/mocks/config.ts）。

import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { MOCK_STATE_STORAGE_KEY, type MockConfig } from "../src/mocks/config";

export { expect };

export const test = base.extend<{ mock: MockConfig }>({
  // 預設：Owner、模擬 Agent 每 20ms 一步
  mock: [{ eventIntervalMs: 20 }, { option: true }],
  page: async ({ page, mock }, use) => {
    await page.addInitScript((config) => {
      window.__MOCK_CONFIG__ = config;
    }, mock);
    await use(page);
  },
});

/** 用滑鼠把 `source` 拖到 `target`（dnd-kit 需要中間的移動事件）。 */
export async function dragTo(page: Page, source: Locator, target: Locator): Promise<void> {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("找不到要拖曳的元素");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 5 });
  // 欄位可能有一部分在視窗外（左側有側欄），目標點取欄位在視窗內的部分；視窗外的指標事件在 Windows 收不到
  const viewport = page.viewportSize();
  const x = Math.min(to.x + to.width / 2, (viewport?.width ?? to.x + to.width) - 10);
  await page.mouse.move(Math.max(to.x + 10, x), to.y + 60, { steps: 15 });
}

/** 放開滑鼠，完成拖曳。 */
export async function drop(page: Page): Promise<void> {
  await page.mouse.up();
}

export function column(page: Page, status: string): Locator {
  return page.locator(`[data-status="${status}"].board-column`);
}

export function card(page: Page, taskKey: string): Locator {
  return page.locator(`[data-task-key="${taskKey}"]`);
}

/** 讀出 MSW 假後端目前的狀態（存在 sessionStorage）。 */
export async function mockState<T = Record<string, unknown>>(page: Page): Promise<T> {
  return page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key) ?? "{}"),
    MOCK_STATE_STORAGE_KEY,
  );
}

/** 從 Task 頁派工（預設選項），等到進入 Run 頁。 */
export async function dispatchTask(page: Page, taskKey: string): Promise<void> {
  await page.goto(`/tasks/${taskKey}`);
  await page.getByRole("button", { name: "派工" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "派工" }).click();
  await expect(page).toHaveURL(/\/runs\/run-\d+$/);
}

/** 在頁面中呼叫 API（經過 MSW 假後端），用來準備測試資料。 */
export async function apiCall(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  // MSW 的 service worker 接管頁面之後，fetch 才會進到假後端
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null);
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${method} ${path}：HTTP ${response.status}`);
      return response.status === 204 ? null : response.json();
    },
    { method, path, body },
  );
}

/** 允許時間軸上等待中的權限請求。 */
export async function allowPermission(page: Page): Promise<void> {
  await page
    .getByTestId("timeline")
    .locator('.event-permission[data-resolved="false"]')
    .getByRole("button", { name: "允許" })
    .click();
}

/** 開啟新增任務對話框（看板上的「新增」按鈕）。 */
export async function openNewTask(page: Page): Promise<Locator> {
  await page
    .getByRole("button", { name: /^新增(任務| Task)$/ })
    .first()
    .click();
  return page.getByRole("dialog", { name: "新增任務" });
}

/** 以新增任務對話框建立 Task 並開啟它的工作區。 */
export async function createTask(
  page: Page,
  { title, description }: { title: string; description?: string },
): Promise<void> {
  const dialog = await openNewTask(page);
  await dialog.getByRole("textbox", { name: "任務標題" }).fill(title);
  if (description) await dialog.getByRole("textbox", { name: "描述要做什麼" }).fill(description);
  await dialog.getByRole("button", { name: /^建立並開啟/ }).click();
}

/** 個人選單中顯示的 Team Role。 */
export async function expectTeamRole(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "個人選單" }).click();
  await expect(page.getByTestId("member-role")).toHaveText(label);
  await page.keyboard.press("Escape");
}

/** 從個人選單選一項（設定、執行器、管理、登出）。 */
export async function openProfileMenuItem(page: Page, name: string | RegExp): Promise<void> {
  await page.getByRole("button", { name: "個人選單" }).click();
  await page.getByRole("menu", { name: "個人選單" }).getByRole("menuitem", { name }).click();
}

/** 前往頁面並等版面骨架載入（全域快捷鍵在那之後才有作用）。 */
export async function gotoShell(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("button", { name: "個人選單" })).toBeVisible();
}
