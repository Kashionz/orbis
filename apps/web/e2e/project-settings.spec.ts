import { NAMES, type Role } from "@orbis/api-contract";
import type { Page } from "@playwright/test";
import {
  expect,
  menuItem,
  openNewTask,
  openProjectMenu,
  projectMenuButton,
  test,
} from "./fixtures";

const INSTALL_URL = `https://github.com/apps/${NAMES.productSlug}/installations/new`;

function repoRow(page: Page, fullName: string) {
  return page.locator(`tr[data-repo="${fullName}"]`);
}

test.describe("建立 Project", () => {
  test("從看板新增 Project：驗證錯誤、前綴重複（409），建立後切換到它的看板", async ({ page }) => {
    await page.goto("/board");
    await menuItem(await openProjectMenu(page), "新增專案").click();
    const dialog = page.getByRole("dialog", { name: "新增專案" });

    // 表單驗證：每個欄位標出契約的規則
    await dialog.getByLabel("任務編號前綴").fill("1x");
    await dialog.getByRole("button", { name: "建立" }).click();
    await expect(dialog.getByLabel("名稱")).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByLabel("任務編號前綴")).toHaveAttribute("aria-invalid", "true");
    await expect(dialog).toContainText(
      "Project 前綴必須是 2–10 個大寫英文字母或數字，並以字母開頭",
    );

    // 前綴已被使用：顯示 Server 的 409
    await dialog.getByLabel("名稱").fill("網站");
    await dialog.getByLabel("任務編號前綴").fill("orb");
    await dialog.getByLabel("描述").fill("官方網站");
    await dialog.getByRole("button", { name: "建立" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Task Key 前綴 ORB 已被使用");
    await expect(dialog.getByLabel("任務編號前綴")).not.toHaveAttribute("aria-invalid");

    await dialog.getByLabel("任務編號前綴").fill("web");
    await dialog.getByRole("button", { name: "建立" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/board\?project=project-\d+$/);
    await expect(projectMenuButton(page)).toHaveAccessibleName("專案 網站");
    await expect(page.locator("[data-task-key]")).toHaveCount(0);

    // 還沒有 Repo：新增任務時提示先到專案設定登記
    const createTask = await openNewTask(page);
    await expect(createTask).toContainText("這個專案還沒有登記儲存庫");
    await createTask.getByRole("link", { name: "專案設定" }).click();
    await expect(page).toHaveURL(/\/projects\/project-\d+\/settings$/);
    await expect(page.getByText("還沒有登記任何儲存庫。")).toBeVisible();
    await expect(page.getByLabel("名稱", { exact: true })).toHaveValue("網站");
    await expect(page.getByLabel("描述")).toHaveValue("官方網站");
  });

  test.describe("剛建立的 Team", () => {
    test.use({ mock: { projects: "none" } });

    test("還沒有任何 Project 時可以直接新增", async ({ page }) => {
      await page.goto("/board");
      await expect(page.getByText("還沒有任何專案")).toBeVisible();
      await page.getByRole("button", { name: "新增專案" }).click();
      const dialog = page.getByRole("dialog", { name: "新增專案" });
      await dialog.getByLabel("名稱").fill(NAMES.productName);
      await dialog.getByLabel("任務編號前綴").fill("ORB");
      await dialog.getByRole("button", { name: "建立" }).click();
      await expect(projectMenuButton(page)).toHaveAccessibleName(`專案 ${NAMES.productName}`);
      await page.getByRole("radio", { name: "分欄" }).click();
      await expect(page.locator(".bd-column")).toHaveCount(9);
    });
  });
});

test.describe("Project 設定頁", () => {
  test("從看板進入，登記 Repo 後出現在列表；App 未安裝時顯示安裝連結", async ({ page }) => {
    await page.goto("/board");
    await menuItem(await openProjectMenu(page), "專案設定").click();
    await expect(page).toHaveURL(/\/projects\/project-1\/settings$/);
    await expect(repoRow(page, "acme/demo")).toContainText("已安裝");

    const form = page.getByRole("form", { name: "登記儲存庫" });

    // 表單驗證
    await form.getByLabel("帳號或組織").fill("-acme");
    await form.getByLabel("儲存庫名稱").fill("..");
    await form.getByRole("button", { name: "登記" }).click();
    await expect(form).toContainText("不是合法的 GitHub 使用者或組織名稱");
    await expect(form).toContainText("不是合法的 GitHub repository 名稱");

    // App 已安裝：default branch 以 GitHub 為準
    await form.getByLabel("帳號或組織").fill("acme");
    await form.getByLabel("儲存庫名稱").fill("api");
    await form.getByLabel("預設分支").fill("develop");
    await form.getByRole("button", { name: "登記" }).click();
    await expect(repoRow(page, "acme/api")).toContainText("main");
    await expect(repoRow(page, "acme/api")).toContainText("已安裝");
    await expect(form.getByLabel("帳號或組織")).toHaveValue("");

    // App 未安裝：default branch 不填時用 main，顯示安裝連結（在外部瀏覽器開啟）
    await form.getByLabel("帳號或組織").fill("octocat");
    await form.getByLabel("儲存庫名稱").fill("tools");
    await form.getByRole("button", { name: "登記" }).click();
    const tools = repoRow(page, "octocat/tools");
    await expect(tools).toContainText("main");
    await expect(tools).toContainText("未安裝");
    const install = tools.getByRole("link", { name: "安裝 GitHub App" });
    await expect(install).toHaveAttribute("href", INSTALL_URL);
    await expect(install).toHaveAttribute("target", "_blank");
    await expect(repoRow(page, "acme/demo").getByRole("link")).toHaveCount(0);

    // 重複登記：顯示 Server 的 409
    await form.getByLabel("帳號或組織").fill("octocat");
    await form.getByLabel("儲存庫名稱").fill("tools");
    await form.getByRole("button", { name: "登記" }).click();
    await expect(form.getByRole("alert")).toHaveText("octocat/tools 已經登記在這個 Project");

    // 新登記的 Repo 可以在新增任務時選
    await page.getByRole("link", { name: "核心產品" }).click();
    const dialog = await openNewTask(page);
    await dialog.getByRole("button", { name: /^儲存庫/ }).click();
    await expect(page.getByRole("menu", { name: "儲存庫" }).getByRole("menuitemradio")).toHaveText([
      "acme/demo",
      "acme/api",
      "octocat/tools",
      "尚未指定",
    ]);
  });

  test("修改名稱、描述與預設 Permission Policy；派工對話框跟著用新的預設", async ({ page }) => {
    await page.goto("/projects/project-1/settings");
    const save = page.getByRole("button", { name: "儲存", exact: true });
    await expect(save).toBeDisabled();
    await page.getByLabel("名稱", { exact: true }).fill("");
    await expect(page.getByLabel("名稱", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeDisabled();
    await page.getByLabel("名稱", { exact: true }).fill("核心產品 v2");
    await page.getByLabel("描述").fill("主要的產品");
    await save.click();
    await expect(save).toBeDisabled();
    await expect(page.getByRole("link", { name: "核心產品 v2" })).toBeVisible();

    // 其他政策另有表單（plan-gate.spec.ts 測修改）
    await expect(
      page.getByRole("form", { name: "其他政策" }).getByLabel("需要計畫關卡（任務可以個別覆寫）"),
    ).not.toBeChecked();

    await page.getByLabel("預設權限策略").selectOption("manual");
    await page.getByRole("button", { name: "儲存政策" }).click();
    await expect(page.getByRole("button", { name: "儲存政策" })).toBeDisabled();

    await page.goto("/board");
    await expect(projectMenuButton(page)).toHaveAccessibleName("專案 核心產品 v2");
    await page.goto("/tasks/ORB-2");
    const dispatch = page.getByRole("form", { name: "派工" });
    await expect(dispatch.getByRole("radio", { name: "逐一確認" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

test.describe("重新檢查 GitHub App 安裝狀態（#56）", () => {
  test.describe("登記之後才安裝 App", () => {
    test.use({ mock: { githubAppOwnersOnRefresh: ["acme", "octocat"] } });

    test("未安裝的 Repo 重新檢查後變成已安裝", async ({ page }) => {
      await page.goto("/projects/project-1/settings");
      const form = page.getByRole("form", { name: "登記儲存庫" });
      await form.getByLabel("帳號或組織").fill("octocat");
      await form.getByLabel("儲存庫名稱").fill("tools");
      await form.getByRole("button", { name: "登記" }).click();
      const tools = repoRow(page, "octocat/tools");
      await expect(tools).toContainText("未安裝");
      await expect(repoRow(page, "acme/demo").getByRole("button")).toHaveCount(0);

      await tools.getByRole("button", { name: "重新檢查 GitHub App 安裝狀態" }).click();
      await expect(tools.locator("[data-installed]")).toHaveAttribute("data-installed", "true");
      await expect(tools).toContainText("已安裝");
      await page.reload();
      await expect(repoRow(page, "octocat/tools")).toContainText("已安裝");
    });
  });

  test("仍然沒有安裝時提示安裝後再試", async ({ page }) => {
    await page.goto("/projects/project-1/settings");
    const form = page.getByRole("form", { name: "登記儲存庫" });
    await form.getByLabel("帳號或組織").fill("octocat");
    await form.getByLabel("儲存庫名稱").fill("tools");
    await form.getByRole("button", { name: "登記" }).click();
    const tools = repoRow(page, "octocat/tools");
    await tools.getByRole("button", { name: "重新檢查 GitHub App 安裝狀態" }).click();
    await expect(tools.getByRole("status")).toHaveText(
      "GitHub 上仍然沒有安裝。安裝完成後再按一次。",
    );
  });

  test.describe("GitHub 上的 repo 已經不是同一個", () => {
    test.use({ mock: { repoMismatch: ["octocat/tools"] } });

    test("409 repo_mismatch 時提示刪除後重新登記，可以直接刪除", async ({ page }) => {
      await page.goto("/projects/project-1/settings");
      const form = page.getByRole("form", { name: "登記儲存庫" });
      await form.getByLabel("帳號或組織").fill("octocat");
      await form.getByLabel("儲存庫名稱").fill("tools");
      await form.getByRole("button", { name: "登記" }).click();
      const tools = repoRow(page, "octocat/tools");
      await tools.getByRole("button", { name: "重新檢查 GitHub App 安裝狀態" }).click();
      const alert = tools.getByRole("alert");
      await expect(alert).toContainText("請刪除這個儲存庫後重新登記");
      await alert.getByRole("button", { name: "刪除這個儲存庫" }).click();
      await alert.getByRole("button", { name: "確定刪除這個儲存庫" }).click();
      await expect(repoRow(page, "octocat/tools")).toHaveCount(0);
    });
  });
});

/** Member／Viewer 看不到建立 Project、登記 Repo、修改設定；Repo 列表與政策仍可以查看。 */
for (const role of ["member", "viewer"] as const satisfies readonly Role[]) {
  test.describe(`Role：${role}`, () => {
    test.use({ mock: { role } });

    test("看不到新增 Project、登記 Repo 與修改設定", async ({ page }) => {
      await page.goto("/board");
      const menu = await openProjectMenu(page);
      await expect(menuItem(menu, "專案設定")).toBeVisible();
      await expect(menuItem(menu, "新增專案")).toHaveCount(0);

      await menuItem(menu, "專案設定").click();
      await expect(repoRow(page, "acme/demo")).toContainText("已安裝");
      await expect(page.getByRole("form", { name: "登記儲存庫" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "儲存" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "儲存政策" })).toHaveCount(0);
      await expect(page.getByTestId("default-permission-policy")).toHaveText("自動");
    });
  });

  test.describe(`Role：${role}（剛建立的 Team）`, () => {
    test.use({ mock: { role, projects: "none" } });

    test("還沒有任何 Project 時請 Owner 或 Admin 建立", async ({ page }) => {
      await page.goto("/board");
      await expect(page.getByText("請團隊的擁有者或管理員建立專案")).toBeVisible();
      await expect(page.getByRole("button", { name: "新增專案" })).toHaveCount(0);
    });
  });
}

test.describe("Project 的 Role 覆寫", () => {
  // Team 是 Admin，但在「核心產品」被覆寫成 Member
  test.use({ mock: { role: "admin", projectRole: "member" } });

  test("建立 Project 看 Team 的 Role；Project 設定看這個 Project 的有效 Role", async ({ page }) => {
    await page.goto("/board");
    const menu = await openProjectMenu(page);
    await expect(menuItem(menu, "新增專案")).toBeVisible();
    await menuItem(menu, "專案設定").click();
    await expect(page.getByRole("form", { name: "登記儲存庫" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "儲存政策" })).toHaveCount(0);

    // 沒有被覆寫的 Project 仍是 Admin
    await page.goto("/projects/project-2/settings");
    await expect(page.getByRole("form", { name: "登記儲存庫" })).toBeVisible();
    await expect(page.getByRole("button", { name: "儲存政策" })).toBeVisible();
  });
});
