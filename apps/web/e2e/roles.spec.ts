import { ROLES, type Role } from "@orbis/api-contract";
import type { Page } from "@playwright/test";
import { card, column, dragTo, drop, expect, permissionRow, test } from "./fixtures";

/** §12.2：Viewer 只能查看與留言，其他 Role 可以編輯、派工、回覆、核准。 */
const canEdit = (role: Role) => role !== "viewer";

/** 看板切到分欄檢視。 */
async function columnsView(page: Page) {
  await page.goto("/board");
  await page.getByRole("radio", { name: "分欄" }).click();
  await expect(page.getByTestId("board-columns")).toBeVisible();
}

const newTask = (page: Page) => page.getByRole("button", { name: "新增任務" });

for (const role of ROLES) {
  test.describe(`Role：${role}`, () => {
    test.use({ mock: { role, eventIntervalMs: 20 } });

    test("看板：新增任務與拖曳", async ({ page }) => {
      await columnsView(page);
      if (canEdit(role)) await expect(newTask(page).first()).toBeVisible();
      else await expect(newTask(page)).toHaveCount(0);

      await dragTo(page, card(page, "ORB-1"), column(page, "ready"));
      // Viewer 拖不動，不會標示可以放下的欄
      if (canEdit(role)) {
        await expect(column(page, "ready")).toHaveAttribute("data-drop-allowed", "true");
      } else {
        await expect(column(page, "ready")).not.toHaveAttribute("data-drop-allowed", "true");
      }
      await drop(page);
      const target = canEdit(role) ? "ready" : "backlog";
      await expect(column(page, target).locator('[data-task-key="ORB-1"]')).toBeVisible();
    });

    test("任務分頁：編輯規格、指派、派工", async ({ page }) => {
      await page.goto("/tasks/ORB-2");
      await expect(page.getByRole("heading", { name: /新增 hello.txt/ })).toBeVisible();
      await expect(page.locator(".rp-criterion")).toHaveCount(2);
      const count = canEdit(role) ? 1 : 0;
      const panel = page.getByRole("tabpanel");
      await expect(panel.getByRole("button", { name: "編輯", exact: true })).toHaveCount(count);
      await expect(panel.getByRole("button", { name: "指派對象" })).toHaveCount(count);
      await expect(page.getByRole("form", { name: "派工" })).toHaveCount(count);
      // 檢視模式的規格一律唯讀；可以編輯的人按「編輯」後才能改
      await expect(page.getByRole("textbox", { name: "規格" })).toHaveAttribute(
        "contenteditable",
        "false",
      );
      if (canEdit(role)) {
        await panel.getByRole("button", { name: "編輯", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "規格" })).toHaveAttribute(
          "contenteditable",
          "true",
        );
      }
    });

    test("執行工作區與待我處理：回覆權限請求、中止執行", async ({ page }) => {
      await page.goto("/needs-you");
      // Server 只列出本人有權處理的項目：Viewer 看不到權限請求
      if (canEdit(role)) {
        const item = page.locator(".ny-row", { hasText: "ORB-3" });
        await expect(item.getByRole("button", { name: "允許一次" })).toBeVisible();
        await item.getByRole("button", { name: "前往執行" }).click();
      } else {
        await expect(page.getByText("全部處理完了")).toBeVisible();
        await page.goto("/tasks/ORB-3");
      }

      const request = permissionRow(page);
      await expect(request).toBeVisible();
      if (canEdit(role)) {
        await expect(request.getByRole("button", { name: "允許一次" })).toBeVisible();
        await expect(page.getByRole("button", { name: "中止執行" })).toBeVisible();
      } else {
        await expect(request).toContainText("等待有權限的成員回覆");
        await expect(request.locator(".st-option")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "中止執行" })).toHaveCount(0);
      }
    });

    test("差異審查：留言、退回、核准", async ({ page }) => {
      await page.goto("/tasks/ORB-4");
      await page.getByRole("tab", { name: /差異/ }).click();
      await expect(page.locator(".rp-file").first()).toBeVisible();
      const count = canEdit(role) ? 1 : 0;
      await expect(
        page.getByRole("button", { name: "對修改後第 1 行留言", exact: true }),
      ).toHaveCount(count);
      await expect(page.getByRole("button", { name: /^退回（/ })).toHaveCount(count);
      await expect(page.getByRole("button", { name: "核准並開啟合併請求" })).toHaveCount(count);
    });
  });
}

test.describe("Project 的 Role 覆寫（Project.viewerRole）", () => {
  test.describe("Team 是 Member、Project 覆寫成 Viewer", () => {
    test.use({ mock: { role: "member", projectRole: "viewer" } });

    test("依 Project 的有效 Role 隱藏操作：看不到派工與編輯", async ({ page }) => {
      await page.goto("/tasks/ORB-2");
      await expect(page.getByRole("heading", { name: /新增 hello.txt/ })).toBeVisible();
      await expect(page.getByRole("form", { name: "派工" })).toHaveCount(0);
      await expect(
        page.getByRole("tabpanel").getByRole("button", { name: "編輯", exact: true }),
      ).toHaveCount(0);

      await page.goto("/board");
      await expect(page.locator('[data-status="backlog"] [data-task-key="ORB-1"]')).toBeVisible();
      await expect(newTask(page)).toHaveCount(0);
    });
  });

  test.describe("Team 是 Viewer、Project 覆寫成 Member", () => {
    test.use({ mock: { role: "viewer", projectRole: "member" } });

    test("依 Project 的有效 Role 顯示派工與編輯", async ({ page }) => {
      await page.goto("/tasks/ORB-2");
      await expect(page.getByRole("form", { name: "派工" })).toBeVisible();
      await expect(
        page.getByRole("tabpanel").getByRole("button", { name: "編輯", exact: true }),
      ).toBeVisible();
    });
  });
});

test.describe("Server 拒絕（403）", () => {
  test.use({ mock: { forbidWrites: true } });

  test("UI 顯示沒有權限的錯誤，不會壞掉", async ({ page }) => {
    await columnsView(page);
    await dragTo(page, card(page, "ORB-1"), column(page, "ready"));
    await drop(page);
    await expect(page.getByRole("alert")).toContainText("沒有權限");
    // 樂觀更新還原
    await expect(column(page, "backlog").locator('[data-task-key="ORB-1"]')).toBeVisible();
  });
});
