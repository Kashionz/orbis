// Credential 與佇列（#42）：並行數、用量、rate limit 與排隊數；Admin 以上可以覆寫並行上限。

import { expect, test } from "./fixtures";

test("顯示各 Credential 的並行、排隊、rate limit 與 24 小時用量", async ({ page }) => {
  await page.goto("/admin");
  const section = page.getByRole("region", { name: "Credential" });
  // Owner 看得到所有 Runner 的 Credential
  await expect(section.locator("tbody tr")).toHaveCount(4);
  const claude = section.locator('tr[data-credential="team-claude"]');
  await expect(claude).toContainText("team-runner-1");
  await expect(claude).toContainText("claude-code");
  await expect(claude.getByTestId("concurrency")).toContainText("2 / 30");
  await expect(claude).toContainText("至 ");
  await expect(claude).toContainText("12 個 Run · 輸入 1,250,000 · 輸出 64,000 · USD 18.50");
  await expect(section.locator('tr[data-credential="team-openai"]')).toContainText("正常");

  const queue = page.getByRole("region", { name: "Team Runner 佇列" });
  await expect(queue.locator("tbody tr")).toHaveCount(1);
  await expect(queue).toContainText("Credential 在 rate limit 中");
});

test("Admin 以上可以覆寫並行上限，也可以取消覆寫", async ({ page }) => {
  await page.goto("/admin");
  const claude = page.locator('tr[data-credential="team-claude"]');
  await claude.getByRole("button", { name: "覆寫上限" }).click();
  const form = claude.getByRole("form", { name: "覆寫 team-claude 的並行上限" });
  await form.getByLabel("並行上限").fill("0");
  await expect(form.getByRole("button", { name: "儲存" })).toBeDisabled();
  await form.getByLabel("並行上限").fill("5");
  await form.getByRole("button", { name: "儲存" }).click();
  await expect(claude.getByTestId("concurrency")).toContainText("2 / 5（覆寫；Runner 回報 30）");

  await claude.getByRole("button", { name: "覆寫上限" }).click();
  await claude.getByRole("button", { name: "取消覆寫" }).click();
  await expect(claude.getByTestId("concurrency")).toHaveText(/^2 \/ 30/);
});

test.describe("Member", () => {
  test.use({ mock: { eventIntervalMs: 20, role: "member" } });

  test("只看得到 Team Runner 與自己的 Local Runner 的 Credential", async ({ page }) => {
    await page.goto("/admin");
    const rows = page.getByRole("region", { name: "Credential" }).locator("tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(page.locator('tr[data-runner="alice-mac"]')).toHaveCount(0);
  });
});
