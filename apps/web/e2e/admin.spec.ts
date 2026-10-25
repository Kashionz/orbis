// 管理頁（#42）：成員與角色、專案的角色覆寫、Team Runner 的 Pairing token、Permission Policy 與
// 設定的信任核准（Admin 以上），以及共用訂閱的條款風險警告（ADR-0005）。

import { NAMES } from "@orbis/api-contract";
import { CONFIG_PATH } from "../src/mocks/scripts";
import { expect, openProfileMenuItem, test } from "./fixtures";

test("Owner：新增成員、改 Role、移除；不能降級最後一位 Owner", async ({ page }) => {
  await page.goto("/board");
  await openProfileMenuItem(page, "管理");
  await expect(page).toHaveURL(/\/admin$/);
  const section = page.getByRole("region", { name: "成員與角色" });
  const rows = section.locator("tbody tr");
  await expect(rows).toHaveCount(3);

  const add = section.getByRole("form", { name: "新增成員" });
  await add.getByLabel("GitHub login").fill("ghost");
  await add.getByRole("button", { name: "新增成員" }).click();
  await expect(add.getByRole("alert")).toContainText("GitHub 上找不到 ghost");
  await add.getByLabel("GitHub login").fill("carol");
  await add.getByLabel("角色").selectOption("viewer");
  await add.getByRole("button", { name: "新增成員" }).click();
  await expect(rows).toHaveCount(4);
  await expect(section.getByLabel("@carol 的角色")).toHaveValue("viewer");

  await section.getByLabel("@bob 的角色").selectOption("admin");
  await expect(section.getByLabel("@bob 的角色")).toHaveValue("admin");

  const alice = section.locator('tr[data-member="alice"]');
  await alice.getByRole("button", { name: "移除" }).click();
  await alice.getByRole("button", { name: "確定移除 @alice" }).click();
  await expect(rows).toHaveCount(3);

  await section.getByLabel("@octocat 的角色").selectOption("admin");
  await expect(section.locator('tr[data-member="octocat"]').getByRole("alert")).toContainText(
    "不能移除或降級最後一位 Owner",
  );
});

test("Project 的 Role 覆寫：列出、修改、取消、新增（不能覆寫成 Owner）", async ({ page }) => {
  await page.goto("/admin");
  const section = page.getByRole("region", { name: "專案的角色覆寫" });
  const overrides = section.getByRole("list", { name: "角色覆寫" });
  await expect(overrides.locator('li[data-member="bob"]')).toBeVisible();
  await expect(section.getByLabel("@bob 在這個專案的角色").locator("option")).toHaveText([
    "管理員",
    "成員",
    "檢視者",
  ]);
  await section.getByLabel("@bob 在這個專案的角色").selectOption("member");
  await expect(section.getByLabel("@bob 在這個專案的角色")).toHaveValue("member");

  const form = section.getByRole("form", { name: "新增角色覆寫" });
  await form.getByLabel("成員", { exact: true }).selectOption({ label: "@alice（團隊：管理員）" });
  await form.getByLabel("覆寫成").selectOption("viewer");
  await form.getByRole("button", { name: "新增覆寫" }).click();
  await expect(overrides.locator('li[data-member="alice"]')).toBeVisible();

  await overrides
    .locator('li[data-member="bob"]')
    .getByRole("button", { name: "取消覆寫" })
    .click();
  await expect(overrides.locator('li[data-member="bob"]')).toHaveCount(0);
});

test("Team Runner：條款風險警告、Runner 列表、產生只顯示一次的 Pairing token", async ({ page }) => {
  await page.goto("/admin");
  const section = page.getByRole("region", { name: "執行器", exact: true });
  await expect(section.getByRole("note", { name: "共用訂閱的條款風險" })).toContainText(
    "團隊執行器共用一個 Claude 訂閱",
  );
  await expect(section.locator("tbody tr")).toHaveCount(3);
  await expect(section.locator('tr[data-runner="alice-mac"]')).toContainText("離線");
  await section.getByRole("button", { name: "產生團隊執行器的配對碼" }).click();
  const token = section.getByRole("status");
  await expect(token.getByTestId("pairing-token")).toContainText("pt_team_");
  await expect(token).toContainText(NAMES.runnerEnv.pairingToken);
  await expect(token).toContainText(NAMES.runnerEnv.serverUrl);
});

test.describe("設定的信任核准", () => {
  test.use({ mock: { eventIntervalMs: 20, configTrust: true } });

  test("各 Project 的預設 Permission Policy 與等待核准的信任請求", async ({ page }) => {
    await page.goto("/admin");
    const section = page.getByRole("region", { name: "權限策略與設定的信任核准" });
    const select = section.getByLabel("核心產品 的預設權限策略");
    await select.selectOption("manual");
    await section.locator('tr[data-project="ORB"]').getByRole("button", { name: "儲存" }).click();
    await page.reload();
    await expect(select).toHaveValue("manual");

    const request = section.locator(".trust-request");
    await expect(request).toContainText(`執行 ${CONFIG_PATH} 的 setup`);
    await request.getByRole("button", { name: "信任並執行" }).click();
    await expect(request).toHaveCount(0);
    await expect(section.getByText("沒有等待核准的請求。")).toBeVisible();
  });
});

test.describe("Admin", () => {
  test.use({ mock: { eventIntervalMs: 20, role: "admin" } });

  test("不能指派 Owner", async ({ page }) => {
    await page.goto("/admin");
    const add = page.getByRole("form", { name: "新增成員" });
    await expect(add.getByLabel("角色").locator("option")).toHaveText(["管理員", "成員", "檢視者"]);
  });
});

test.describe("Member", () => {
  test.use({ mock: { eventIntervalMs: 20, role: "member" } });

  test("只看得到憑證與佇列，看不到管理員的區塊", async ({ page }) => {
    await page.goto("/board");
    await openProfileMenuItem(page, "管理");
    await expect(page.getByRole("region", { name: "憑證" })).toBeVisible();
    await expect(page.getByRole("region", { name: "團隊執行器佇列" })).toBeVisible();
    for (const name of ["成員與角色", "專案的角色覆寫", "執行器", "權限策略與設定的信任核准"]) {
      await expect(page.getByRole("region", { name, exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: "覆寫上限" })).toHaveCount(0);
  });
});

test.describe("Viewer", () => {
  test.use({ mock: { eventIntervalMs: 20, role: "viewer" } });

  test("沒有管理的入口，直接進入顯示沒有權限", async ({ page }) => {
    await page.goto("/board");
    await page.getByRole("button", { name: "個人選單" }).click();
    await expect(page.getByRole("menuitem", { name: "管理" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "沒有權限" })).toBeVisible();
  });
});
