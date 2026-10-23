// 即時共同編輯的完成條件：兩個瀏覽器 context 編輯同一份 Task 描述，內容即時同步、看得到對方在線，
// 都離開後 Server 把內容轉成 markdown 回寫 Task 描述。跑在真實 Server（B2 的 /api/collab）上。

import { API_ROUTES, apiPath, Task } from "@orbis/api-contract";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { readStack } from "./stack";

const stack = readStack();

async function openTask(context: BrowserContext, baseURL: string, key: string): Promise<Page> {
  await context.addCookies([{ ...stack.sessionCookie, url: baseURL }]);
  const page = await context.newPage();
  await page.goto(`/tasks/${key}`);
  await expect(page.getByTestId("collab-status")).toHaveText("已同步");
  return page;
}

test("兩個 context 同時編輯 Task 描述，內容即時同步並回寫", async ({ browser, baseURL }) => {
  const origin = baseURL ?? "";
  const first = await browser.newContext({ baseURL: origin });
  await first.addCookies([{ ...stack.sessionCookie, url: origin }]);
  const created = await first.request.post(
    apiPath(API_ROUTES.projectTasks, { projectId: stack.projectId }),
    {
      headers: { origin },
      data: { repoId: stack.repoId, title: "C2：共同編輯", description: "第一段。" },
    },
  );
  const task = Task.parse(await created.json());

  const a = await openTask(first, origin, task.key);
  const second = await browser.newContext({ baseURL: origin });
  const b = await openTask(second, origin, task.key);
  const editorA = a.getByRole("textbox", { name: "描述" });
  const editorB = b.getByRole("textbox", { name: "描述" });
  await expect(editorB).toContainText("第一段。");

  // 對方在線
  await expect(a.getByRole("list", { name: "正在編輯的人" })).toBeVisible();
  await expect(b.getByRole("list", { name: "正在編輯的人" })).toBeVisible();

  // 點最後一段再按 End：游標一定在文件末尾
  await editorA.locator("p").last().click();
  // 點擊後立刻輸入時，偶爾游標會被重設到文件開頭（只在真實 Server 出現，原因待查），先等選取穩定
  await a.waitForTimeout(300);
  await a.keyboard.press("End");
  await a.keyboard.press("Enter");
  await a.keyboard.type("A 寫的第二段。");
  await expect(editorB).toContainText("A 寫的第二段。");

  // 點最後一段再按 End：游標一定在文件末尾
  await editorB.locator("p").last().click();
  // 點擊後立刻輸入時，偶爾游標會被重設到文件開頭（只在真實 Server 出現，原因待查），先等選取穩定
  await b.waitForTimeout(300);
  await b.keyboard.press("End");

  await b.keyboard.press("Enter");
  await b.keyboard.type("B 寫的第三段。");
  await expect(editorA).toContainText("B 寫的第三段。");

  await first.close();
  await second.close();

  // 最後一個 client 離開後 Server 回寫 markdown
  const reader = await browser.newContext({ baseURL: origin });
  await reader.addCookies([{ ...stack.sessionCookie, url: origin }]);
  await expect
    .poll(async () => {
      const response = await reader.request.get(apiPath(API_ROUTES.task, { taskId: task.id }));
      return Task.parse(await response.json()).description;
    })
    .toBe("第一段。\n\nA 寫的第二段。\n\nB 寫的第三段。");
  await reader.close();
});
