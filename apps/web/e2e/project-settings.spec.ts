import { NAMES, type Role } from "@orbis/api-contract";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const INSTALL_URL = `https://github.com/apps/${NAMES.productSlug}/installations/new`;

function repoRow(page: Page, fullName: string) {
  return page.locator(`tr[data-repo="${fullName}"]`);
}

test.describe("建立 Project", () => {
  test("從看板新增 Project：驗證錯誤、前綴重複（409），建立後切換到它的看板", async ({ page }) => {
    await page.goto("/board");
    await page.getByRole("button", { name: "新增 Project" }).click();
    const dialog = page.getByRole("dialog", { name: "新增 Project" });

    // 表單驗證：每個欄位標出契約的規則
    await dialog.getByLabel("Task Key 前綴").fill("1x");
    await dialog.getByRole("button", { name: "建立" }).click();
    await expect(dialog.getByLabel("名稱")).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByLabel("Task Key 前綴")).toHaveAttribute("aria-invalid", "true");
    await expect(dialog).toContainText(
      "Project 前綴必須是 2–10 個大寫英文字母或數字，並以字母開頭",
    );

    // 前綴已被使用：顯示 Server 的 409
    await dialog.getByLabel("名稱").fill("網站");
    await dialog.getByLabel("Task Key 前綴").fill("orb");
    await dialog.getByLabel("描述").fill("官方網站");
    await dialog.getByRole("button", { name: "建立" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Task Key 前綴 ORB 已被使用");
    await expect(dialog.getByLabel("Task Key 前綴")).not.toHaveAttribute("aria-invalid");

    await dialog.getByLabel("Task Key 前綴").fill("web");
    await dialog.getByRole("button", { name: "建立" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/board\?project=project-\d+$/);
    await expect(page.getByRole("combobox", { name: "Project", exact: true })).toHaveValue(
      /^project-\d+$/,
    );
    await expect(
      page.getByRole("combobox", { name: "Project", exact: true }).locator("option:checked"),
    ).toHaveText("網站（WEB）");
    await expect(page.locator(".task-card")).toHaveCount(0);
    await expect(page.getByPlaceholder("用 Task Key 搜尋，例如 WEB-1")).toBeVisible();

    // 還沒有 Repo：新增 Task 時提示先到 Project 設定登記
    await page.getByRole("button", { name: "新增 Task" }).click();
    const createTask = page.getByRole("dialog", { name: "新增 Task" });
    await expect(createTask.locator(".warning")).toContainText("這個 Project 還沒有登記 Repo");
    await createTask.getByRole("link", { name: "Project 設定" }).click();
    await expect(page).toHaveURL(/\/projects\/project-\d+\/settings$/);
    await expect(page.getByText("還沒有登記任何 Repo。")).toBeVisible();
    await expect(page.getByLabel("名稱", { exact: true })).toHaveValue("網站");
    await expect(page.getByLabel("描述")).toHaveValue("官方網站");
  });

  test.describe("剛建立的 Team", () => {
    test.use({ mock: { projects: "none" } });

    test("還沒有任何 Project 時可以直接新增", async ({ page }) => {
      await page.goto("/board");
      await expect(page.getByRole("heading", { name: "還沒有任何 Project" })).toBeVisible();
      await page.getByRole("button", { name: "新增 Project" }).click();
      const dialog = page.getByRole("dialog", { name: "新增 Project" });
      await dialog.getByLabel("名稱").fill(NAMES.productName);
      await dialog.getByLabel("Task Key 前綴").fill("ORB");
      await dialog.getByRole("button", { name: "建立" }).click();
      await expect(
        page.getByRole("combobox", { name: "Project", exact: true }).locator("option:checked"),
      ).toHaveText(`${NAMES.productName}（ORB）`);
      await expect(page.locator(".board-column")).toHaveCount(9);
    });
  });
});

test.describe("Project 設定頁", () => {
  test("從看板進入，登記 Repo 後出現在列表；App 未安裝時顯示安裝連結", async ({ page }) => {
    await page.goto("/board");
    await page.getByRole("link", { name: "Project 設定" }).click();
    await expect(page).toHaveURL(/\/projects\/project-1\/settings$/);
    await expect(repoRow(page, "acme/demo")).toContainText("已安裝");

    const form = page.getByRole("form", { name: "登記 Repo" });

    // 表單驗證
    await form.getByLabel("Owner").fill("-acme");
    await form.getByLabel("Repo 名稱").fill("..");
    await form.getByRole("button", { name: "登記" }).click();
    await expect(form).toContainText("不是合法的 GitHub 使用者或組織名稱");
    await expect(form).toContainText("不是合法的 GitHub repository 名稱");

    // App 已安裝：default branch 以 GitHub 為準
    await form.getByLabel("Owner").fill("acme");
    await form.getByLabel("Repo 名稱").fill("api");
    await form.getByLabel("Default branch").fill("develop");
    await form.getByRole("button", { name: "登記" }).click();
    await expect(repoRow(page, "acme/api")).toContainText("main");
    await expect(repoRow(page, "acme/api")).toContainText("已安裝");
    await expect(form.getByLabel("Owner")).toHaveValue("");

    // App 未安裝：default branch 不填時用 main，顯示安裝連結（在外部瀏覽器開啟）
    await form.getByLabel("Owner").fill("octocat");
    await form.getByLabel("Repo 名稱").fill("tools");
    await form.getByRole("button", { name: "登記" }).click();
    const tools = repoRow(page, "octocat/tools");
    await expect(tools).toContainText("main");
    await expect(tools).toContainText("未安裝");
    const install = tools.getByRole("link", { name: "安裝 GitHub App" });
    await expect(install).toHaveAttribute("href", INSTALL_URL);
    await expect(install).toHaveAttribute("target", "_blank");
    await expect(repoRow(page, "acme/demo").getByRole("link")).toHaveCount(0);

    // 重複登記：顯示 Server 的 409
    await form.getByLabel("Owner").fill("octocat");
    await form.getByLabel("Repo 名稱").fill("tools");
    await form.getByRole("button", { name: "登記" }).click();
    await expect(form.getByRole("alert")).toHaveText("octocat/tools 已經登記在這個 Project");

    // 新登記的 Repo 可以在新增 Task 時選
    await page.getByRole("link", { name: "核心產品" }).click();
    await page.getByRole("button", { name: "新增 Task" }).click();
    await expect(
      page.getByRole("dialog", { name: "新增 Task" }).getByLabel("Repo").locator("option"),
    ).toHaveText(["acme/demo", "acme/api", "octocat/tools"]);
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

    // 其他政策只顯示
    const others = page.getByRole("definition").filter({ hasText: /^(開啟|關閉)$/ });
    await expect(others).toHaveText("關閉");

    await page.getByLabel("預設 Permission Policy").selectOption("manual");
    await page.getByRole("button", { name: "儲存政策" }).click();
    await expect(page.getByRole("button", { name: "儲存政策" })).toBeDisabled();

    await page.goto("/board");
    await expect(
      page.getByRole("combobox", { name: "Project", exact: true }).locator("option:checked"),
    ).toHaveText("核心產品 v2（ORB）");
    await page.goto("/tasks/ORB-2");
    await page.getByRole("button", { name: "派工" }).click();
    const dispatch = page.getByRole("dialog", { name: "派工 ORB-2" });
    await expect(dispatch.getByRole("radio", { name: /^manual/ })).toBeChecked();
  });
});

test.describe("重新檢查 GitHub App 安裝狀態（#56）", () => {
  test.describe("登記之後才安裝 App", () => {
    test.use({ mock: { githubAppOwnersOnRefresh: ["acme", "octocat"] } });

    test("未安裝的 Repo 重新檢查後變成已安裝", async ({ page }) => {
      await page.goto("/projects/project-1/settings");
      const form = page.getByRole("form", { name: "登記 Repo" });
      await form.getByLabel("Owner").fill("octocat");
      await form.getByLabel("Repo 名稱").fill("tools");
      await form.getByRole("button", { name: "登記" }).click();
      const tools = repoRow(page, "octocat/tools");
      await expect(tools).toContainText("未安裝");
      await expect(repoRow(page, "acme/demo").getByRole("button")).toHaveCount(0);

      await tools.getByRole("button", { name: "重新檢查 App 安裝狀態" }).click();
      await expect(tools.locator("[data-installed]")).toHaveAttribute("data-installed", "true");
      await expect(tools).toContainText("已安裝");
      await page.reload();
      await expect(repoRow(page, "octocat/tools")).toContainText("已安裝");
    });
  });

  test("仍然沒有安裝時提示安裝後再試", async ({ page }) => {
    await page.goto("/projects/project-1/settings");
    const form = page.getByRole("form", { name: "登記 Repo" });
    await form.getByLabel("Owner").fill("octocat");
    await form.getByLabel("Repo 名稱").fill("tools");
    await form.getByRole("button", { name: "登記" }).click();
    const tools = repoRow(page, "octocat/tools");
    await tools.getByRole("button", { name: "重新檢查 App 安裝狀態" }).click();
    await expect(tools.getByRole("status")).toHaveText(
      "GitHub 上仍然沒有安裝。安裝完成後再按一次。",
    );
  });

  test.describe("GitHub 上的 repo 已經不是同一個", () => {
    test.use({ mock: { repoMismatch: ["octocat/tools"] } });

    test("409 repo_mismatch 時提示刪除後重新登記，可以直接刪除", async ({ page }) => {
      await page.goto("/projects/project-1/settings");
      const form = page.getByRole("form", { name: "登記 Repo" });
      await form.getByLabel("Owner").fill("octocat");
      await form.getByLabel("Repo 名稱").fill("tools");
      await form.getByRole("button", { name: "登記" }).click();
      const tools = repoRow(page, "octocat/tools");
      await tools.getByRole("button", { name: "重新檢查 App 安裝狀態" }).click();
      const alert = tools.getByRole("alert");
      await expect(alert).toContainText("請刪除這個 Repo 後重新登記");
      await alert.getByRole("button", { name: "刪除這個 Repo" }).click();
      await alert.getByRole("button", { name: "確定刪除這個 Repo" }).click();
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
      await expect(page.getByRole("link", { name: "Project 設定" })).toBeVisible();
      await expect(page.getByRole("button", { name: "新增 Project" })).toHaveCount(0);

      await page.getByRole("link", { name: "Project 設定" }).click();
      await expect(repoRow(page, "acme/demo")).toContainText("已安裝");
      await expect(page.getByRole("form", { name: "登記 Repo" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "儲存" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "儲存政策" })).toHaveCount(0);
      await expect(page.getByTestId("default-permission-policy")).toHaveText(
        "auto：Worktree 內自動允許，其他問我",
      );
    });
  });

  test.describe(`Role：${role}（剛建立的 Team）`, () => {
    test.use({ mock: { role, projects: "none" } });

    test("還沒有任何 Project 時請 Owner 或 Admin 建立", async ({ page }) => {
      await page.goto("/board");
      await expect(page.getByText("請 Team 的 Owner 或 Admin 建立 Project。")).toBeVisible();
      await expect(page.getByRole("button", { name: "新增 Project" })).toHaveCount(0);
    });
  });
}

test.describe("Project 的 Role 覆寫", () => {
  // Team 是 Admin，但在「核心產品」被覆寫成 Member
  test.use({ mock: { role: "admin", projectRole: "member" } });

  test("建立 Project 看 Team 的 Role；Project 設定看這個 Project 的有效 Role", async ({ page }) => {
    await page.goto("/board");
    await expect(page.getByRole("button", { name: "新增 Project" })).toBeVisible();
    await page.getByRole("link", { name: "Project 設定" }).click();
    await expect(page.getByRole("form", { name: "登記 Repo" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "儲存政策" })).toHaveCount(0);

    // 沒有被覆寫的 Project 仍是 Admin
    await page.goto("/projects/project-2/settings");
    await expect(page.getByRole("form", { name: "登記 Repo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "儲存政策" })).toBeVisible();
  });
});
