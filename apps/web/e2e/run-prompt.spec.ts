// 執行中傳訊息給代理（後端缺口 run-prompt、event-actor，ARCHITECTURE §7）：回合中送出的訊息排隊，回合結束前
// 送出；還在排隊時可以收回；中斷並傳送立即送出。

import { dispatchTask, expect, permissionRow, stream, test } from "./fixtures";

test("回合中傳送的訊息排隊，可以收回；回合結束前送出，代理回覆後才進入審查關卡", async ({
  page,
}) => {
  await dispatchTask(page, "ORB-2");
  await expect(page.getByTestId("run-status")).toHaveText("等待權限回覆");

  const input = page.getByRole("textbox", { name: "傳訊息給代理" });
  await input.fill("先不要改 README");
  await page.getByRole("button", { name: "傳送", exact: true }).click();
  const first = stream(page).locator(".st-prompt").filter({ hasText: "先不要改 README" });
  await expect(first).toContainText("排隊中的訊息，回合結束後送出");
  await first.getByRole("button", { name: "收回" }).click();
  await expect(first).toContainText("已收回");
  await expect(first.getByRole("button", { name: "收回" })).toHaveCount(0);

  await input.fill("順便補上測試");
  await page.getByRole("button", { name: "傳送", exact: true }).click();
  const second = stream(page).locator(".st-prompt").filter({ hasText: "順便補上測試" });
  await expect(second).toContainText("排隊中的訊息");

  // 允許權限請求後回合繼續；回合結束前送出排隊的訊息，代理回覆後才停在審查關卡
  await permissionRow(page).getByRole("button", { name: "允許一次" }).click();
  await expect(stream(page)).toContainText("收到，已經照這個方向補上。");
  await expect(page.getByTestId("run-status")).toHaveText("等待審查關卡");
  // 收回的訊息不會送出
  await expect(
    stream(page).locator(".st-prompt").filter({ hasText: "先不要改 README" }),
  ).toHaveCount(1);
});

test("中斷並傳送：訊息立即交給代理，不排隊", async ({ page }) => {
  await dispatchTask(page, "ORB-2");
  await expect(page.getByTestId("run-status")).toHaveText("等待權限回覆");
  await page.getByRole("textbox", { name: "傳訊息給代理" }).fill("改用另一個做法");
  await page.getByRole("button", { name: "中斷目前的回合並傳送" }).click();
  const prompt = stream(page).locator(".st-prompt").filter({ hasText: "改用另一個做法" });
  await expect(prompt).toBeVisible();
  await expect(prompt).not.toContainText("排隊中的訊息");
});

test.describe("Viewer", () => {
  test.use({ mock: { role: "viewer" } });

  test("不能傳訊息給代理", async ({ page }) => {
    await page.goto("/tasks/ORB-3");
    const input = page.getByRole("textbox", { name: "傳訊息給代理" });
    await expect(input).toBeVisible();
    await expect(page.getByRole("button", { name: "傳送", exact: true })).toBeDisabled();
  });
});
