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
  await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 15 });
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
