// 共用元件（新工作區介面 PROMPTS 第 4 點）：在 mock 模式的元件展示頁 /__dev/components 測互動。

import { expect, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.goto("/__dev/components");
});

test.describe("Popover", () => {
  test("開啟後 focus 已勾選的項目，方向鍵移動、Enter 選取並關閉，focus 回到按鈕", async ({
    page,
  }) => {
    const trigger = page.getByRole("button", { name: "模型 sonnet" });
    await trigger.click();
    const menu = page.getByRole("menu", { name: "模型" });
    await expect(menu).toBeVisible();
    // 群組標題、子說明、tag 與勾選
    await expect(menu.getByRole("group", { name: "Claude Code" })).toBeVisible();
    await expect(menu.getByRole("menuitemradio", { name: /Sonnet 5\.5/ })).toBeFocused();
    await expect(menu.getByRole("menuitemradio", { name: /Sonnet 5\.5/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(menu.getByRole("menuitemradio", { name: /Opus 5\.5/ })).toContainText("最強");

    await page.keyboard.press("ArrowUp");
    await expect(menu.getByRole("menuitemradio", { name: /Opus 5\.5/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId("picked-model")).toHaveText("opus");
    await expect(page.getByRole("button", { name: "模型 opus" })).toBeFocused();
  });

  test("停用與固定的項目不能選，停用的有 Tooltip", async ({ page }) => {
    await page.getByRole("button", { name: "模型 sonnet" }).click();
    const menu = page.getByRole("menu", { name: "模型" });
    const disabled = menu.getByRole("menuitemradio", { name: /Grok 4/ });
    await expect(disabled).toHaveAttribute("aria-disabled", "true");
    await disabled.click({ force: true });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitemradio", { name: /Haiku 5\.5/ }).click({ force: true });
    await expect(page.getByTestId("picked-model")).toHaveText("sonnet");
    await disabled.hover();
    await expect(page.getByRole("tooltip")).toHaveText("此模型不支援調整推理強度");
  });

  test("Esc 與點外面關閉；靠近底部時往上開", async ({ page }) => {
    await page.getByRole("button", { name: "模型 sonnet" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    await page.getByRole("button", { name: "模型 sonnet" }).click();
    await page.mouse.click(5, 300);
    await expect(page.getByRole("menu")).toHaveCount(0);

    const bottom = page.getByRole("button", { name: "底部的選單" });
    await bottom.scrollIntoViewIfNeeded();
    await bottom.click();
    const menu = page.getByRole("menu", { name: "底部選單" });
    await expect(menu).toHaveAttribute("data-up", "true");
    const [menuBox, buttonBox] = [await menu.boundingBox(), await bottom.boundingBox()];
    expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(buttonBox?.y ?? 0);
  });
});

test.describe("Tooltip", () => {
  test("450ms 後顯示；300ms 內換到另一個元素時立即顯示；原生 title 也換成 Tooltip", async ({
    page,
  }) => {
    const tooltip = page.getByRole("tooltip");
    await page.getByRole("button", { name: "有 Tooltip 的按鈕" }).hover();
    await expect(tooltip).toHaveAttribute("data-visible", "false");
    await expect(tooltip).toHaveAttribute("data-visible", "true", { timeout: 2_000 });
    await expect(tooltip).toHaveText("完整路徑 D:\\work\\repo\\ORB-42");
    await expect(tooltip).toHaveAttribute("data-mono", "true");

    const native = page.getByRole("button", { name: "原生 title" });
    await native.hover();
    await expect(tooltip).toHaveText("原生 title 也會換成 Tooltip");
    await expect(tooltip).toHaveAttribute("data-visible", "true");
    await expect(native).not.toHaveAttribute("title");

    await page.mouse.down();
    await expect(tooltip).toHaveAttribute("data-visible", "false");
    await page.mouse.up();
  });

  test("只有圖示的按鈕以名稱當 Tooltip；鍵盤 focus 也會顯示", async ({ page }) => {
    await page.getByRole("button", { name: "原生 title" }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "中止執行" })).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveText("中止執行");
    await expect(page.getByRole("tooltip")).toHaveAttribute("data-visible", "true");
  });
});

test.describe("Splitter", () => {
  test("方向鍵每次 16px、有上下限、雙擊重設，寬度存在 localStorage", async ({ page }) => {
    const splitter = page.getByRole("separator", { name: "調整寬度" });
    const width = page.getByTestId("split-width");
    await expect(splitter).toHaveAttribute("aria-valuenow", "240");
    await splitter.focus();
    await page.keyboard.press("ArrowRight");
    await expect(width).toHaveText("256");
    for (let i = 0; i < 20; i += 1) await page.keyboard.press("ArrowRight");
    await expect(width).toHaveText("400");
    await splitter.dblclick();
    await expect(width).toHaveText("240");

    const box = await splitter.boundingBox();
    if (!box) throw new Error("找不到分割線");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 5 });
    await expect(splitter).toHaveAttribute("data-dragging", "true");
    await page.mouse.up();
    await expect(width).toHaveText("180");
    await page.reload();
    await expect(page.getByTestId("split-width")).toHaveText("180");
  });
});

test.describe("FluidList", () => {
  test("高亮塊滑到離指標最近的項目，離開時淡出", async ({ page }) => {
    const list = page.getByRole("region", { name: "fluid" });
    const highlight = list.locator(".o-fluid-highlight");
    const second = list.getByRole("button", { name: "第二項" });
    await second.hover();
    await expect(highlight).toHaveAttribute("data-visible", "true");
    const [h, b] = [await highlight.boundingBox(), await second.boundingBox()];
    expect(Math.round(h?.y ?? 0)).toBe(Math.round(b?.y ?? -1));
    await page.mouse.move(800, 600);
    await expect(highlight).toHaveAttribute("data-visible", "false");
  });
});

test.describe("Segmented 與 Switch", () => {
  test("Segmented 是 radiogroup，←→ 切換選取；Switch 切換，停用的不能切換", async ({ page }) => {
    const group = page.getByRole("radiogroup", { name: "篩選" });
    await expect(group.getByRole("radio", { name: "全部" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(group.getByRole("radio", { name: /待我處理/ })).toContainText("3");
    await group.getByRole("radio", { name: "全部" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: /待我處理/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(group.getByRole("radio", { name: /待我處理/ })).toBeFocused();

    const toggle = page.getByRole("switch", { name: "自動展開工具步驟" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const disabled = page.getByRole("switch", { name: "停用的開關" });
    await disabled.click({ force: true });
    await expect(disabled).toHaveAttribute("aria-checked", "false");
    await expect(disabled).toHaveAttribute("aria-disabled", "true");
  });
});

test.describe("Dialog", () => {
  test("Esc 先關對話框中的選單，再關對話框；focus 回到開啟的按鈕", async ({ page }) => {
    const open = page.getByRole("button", { name: "開啟對話框" });
    await open.click();
    const dialog = page.getByRole("dialog", { name: "測試對話框" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "對話框中的選單" }).click();
    await expect(page.getByRole("menu", { name: "對話框選單" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
  });

  test("Tab 不會離開對話框", async ({ page }) => {
    await page.getByRole("button", { name: "開啟對話框" }).click();
    const dialog = page.getByRole("dialog", { name: "測試對話框" });
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
  });
});

test.describe("其他", () => {
  test("Avatar、AgentLogo、Kbd 與提示", async ({ page }) => {
    const avatars = page.getByRole("region", { name: "avatars" });
    // 沒有專屬 logo 的 Agent 用通用圖示
    await expect(avatars.locator("img.o-agent-logo")).toHaveCount(5);
    await expect(avatars.locator('[data-invert-light="true"]')).toHaveCount(2);
    await expect(avatars.getByText("+1")).toBeVisible();
    await expect(avatars.getByText(/^(Ctrl|⌘) K$/)).toBeVisible();
    await expect(avatars.getByRole("img", { name: "執行中" })).toHaveAttribute("data-live", "true");

    await page.getByRole("button", { name: "顯示提示" }).click();
    await expect(page.getByText("已複製")).toBeVisible();
  });
});

test.describe("工作區版面", () => {
  test("右側面板寬度是 26%–62%，方向鍵每次 2%、雙擊重設 42%，可以隱藏", async ({ page }) => {
    const region = page.getByRole("region", { name: "workspace" });
    const splitter = region.getByRole("separator", { name: "調整面板寬度" });
    await expect(splitter).toHaveAttribute("aria-valuetext", "42%");
    await splitter.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(splitter).toHaveAttribute("aria-valuetext", "44%");
    for (let i = 0; i < 20; i += 1) await page.keyboard.press("ArrowLeft");
    await expect(splitter).toHaveAttribute("aria-valuetext", "62%");
    const panelBox = await region.locator(".ws-panel").boundingBox();
    expect(Math.round(panelBox?.width ?? 0)).toBe(620);
    for (let i = 0; i < 30; i += 1) await page.keyboard.press("ArrowRight");
    await expect(splitter).toHaveAttribute("aria-valuetext", "26%");
    await splitter.dblclick();
    await expect(splitter).toHaveAttribute("aria-valuetext", "42%");

    await region.getByRole("button", { name: "隱藏面板" }).click();
    await expect(region.getByTestId("workspace-panel")).toHaveCount(0);
    await expect(region.getByRole("separator")).toHaveCount(0);
    await region.getByRole("button", { name: "顯示面板" }).click();
    await expect(region.getByTestId("workspace-panel")).toBeVisible();
  });
});
