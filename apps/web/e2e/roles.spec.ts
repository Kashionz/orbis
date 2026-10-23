import { ROLES, type Role } from "@orbis/api-contract";
import { card, column, dragTo, drop, expect, test } from "./fixtures";

/** §12.2：Viewer 只能查看與留言，其他 Role 可以編輯、派工、回覆、核准。 */
const canEdit = (role: Role) => role !== "viewer";

for (const role of ROLES) {
  test.describe(`Role：${role}`, () => {
    test.use({ mock: { role, eventIntervalMs: 20 } });

    test("看板：新增 Task 與拖曳", async ({ page }) => {
      await page.goto("/board");
      await expect(page.locator(".role-badge")).toHaveText(new RegExp(role, "i"));
      await expect(page.getByRole("button", { name: "新增 Task" })).toHaveCount(
        canEdit(role) ? 1 : 0,
      );

      await dragTo(page, card(page, "ORB-1"), column(page, "ready"));
      await expect(page.locator(".board-column[data-drop-allowed]")).toHaveCount(
        canEdit(role) ? 9 : 0,
      );
      await drop(page);
      const target = canEdit(role) ? "ready" : "backlog";
      await expect(column(page, target).locator('[data-task-key="ORB-1"]')).toBeVisible();
    });

    test("Task 頁：編輯、Acceptance Criterion、指派、派工", async ({ page }) => {
      await page.goto("/tasks/ORB-2");
      await expect(page.getByRole("heading", { name: /新增 hello.txt/ })).toBeVisible();
      await expect(page.locator(".ac-list > li")).toHaveCount(2);
      const count = canEdit(role) ? 1 : 0;
      await expect(page.getByRole("button", { name: "編輯標題" })).toHaveCount(count);
      await expect(page.getByRole("textbox", { name: "描述" })).toHaveAttribute(
        "contenteditable",
        String(canEdit(role)),
      );
      await expect(page.getByRole("button", { name: "新增 Acceptance Criterion" })).toHaveCount(
        count,
      );
      await expect(page.locator(".ac-list").getByRole("button", { name: "刪除" })).toHaveCount(
        canEdit(role) ? 2 : 0,
      );
      await expect(page.getByLabel("以 Task Key 加入依賴")).toHaveCount(count);
      await expect(page.getByRole("button", { name: "派工" })).toHaveCount(count);
      await expect(page.getByRole("combobox", { name: "指派對象" })).toHaveCount(count);
    });

    test("Run 頁與 Needs You：回覆權限請求、中止 Run", async ({ page }) => {
      await page.goto("/needs-you");
      // Server 只列出本人有權處理的項目：Viewer 看不到權限請求
      if (canEdit(role)) {
        const item = page.locator(".needs-you-item", { hasText: "ORB-3" });
        await expect(item.getByRole("button", { name: "允許" })).toBeVisible();
        await item.getByRole("link", { name: "前往 Run" }).click();
      } else {
        await expect(page.getByText("目前沒有等待你處理的項目。")).toBeVisible();
        await page.goto("/tasks/ORB-3");
        await page.getByRole("link", { name: "開啟 Run 頁" }).click();
      }

      const request = page.locator(".event-permission");
      await expect(request).toBeVisible();
      if (canEdit(role)) {
        await expect(request.getByRole("button", { name: "允許" })).toBeVisible();
        await expect(page.getByRole("button", { name: "中止 Run" })).toBeVisible();
      } else {
        await expect(request).toContainText("等待有權限的 Member 回覆");
        await expect(request.getByRole("button")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "中止 Run" })).toHaveCount(0);
      }
    });

    test("Diff review：留言、退回、核准", async ({ page }) => {
      await page.goto("/tasks/ORB-4");
      await page.getByRole("link", { name: "開啟 Run 頁" }).click();
      await page.getByRole("link", { name: "Diff review" }).click();
      await expect(page.getByTestId("diff-editor")).toBeVisible();
      const count = canEdit(role) ? 1 : 0;
      await expect(page.getByRole("form", { name: "新增行內留言" })).toHaveCount(count);
      await expect(page.getByRole("button", { name: /退回並附上留言/ })).toHaveCount(count);
      await expect(page.getByRole("button", { name: "核准並開 PR" })).toHaveCount(count);
    });
  });
}

test.describe("Project 的 Role 覆寫（Project.viewerRole）", () => {
  test.describe("Team 是 Member、Project 覆寫成 Viewer", () => {
    test.use({ mock: { role: "member", projectRole: "viewer" } });

    test("依 Project 的有效 Role 隱藏操作：看不到派工與編輯", async ({ page }) => {
      await page.goto("/tasks/ORB-2");
      await expect(page.getByRole("heading", { name: /新增 hello.txt/ })).toBeVisible();
      // 頂部顯示的是 Team 的 Role
      await expect(page.locator(".role-badge")).toHaveText("Member");
      await expect(page.getByRole("button", { name: "派工" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "編輯標題" })).toHaveCount(0);

      await page.goto("/board");
      await expect(column(page, "backlog").locator('[data-task-key="ORB-1"]')).toBeVisible();
      await expect(page.getByRole("button", { name: "新增 Task" })).toHaveCount(0);
    });
  });

  test.describe("Team 是 Viewer、Project 覆寫成 Member", () => {
    test.use({ mock: { role: "viewer", projectRole: "member" } });

    test("依 Project 的有效 Role 顯示派工與編輯", async ({ page }) => {
      await page.goto("/tasks/ORB-2");
      await expect(page.locator(".role-badge")).toHaveText("Viewer");
      await expect(page.getByRole("button", { name: "派工" })).toBeVisible();
      await expect(page.getByRole("button", { name: "編輯標題" })).toBeVisible();
    });
  });
});

test.describe("Server 拒絕（403）", () => {
  test.use({ mock: { forbidWrites: true } });

  test("UI 顯示沒有權限的錯誤，不會壞掉", async ({ page }) => {
    await page.goto("/board");
    await dragTo(page, card(page, "ORB-1"), column(page, "ready"));
    await drop(page);
    await expect(page.getByRole("alert")).toContainText("沒有權限");
    // 樂觀更新還原
    await expect(column(page, "backlog").locator('[data-task-key="ORB-1"]')).toBeVisible();
  });
});
