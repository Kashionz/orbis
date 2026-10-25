// #73 跑在完整系統上：Agent 把模型錯誤當成回覆、不改檔就結束回合（Fake Agent 的 empty-diff.yaml），
// Runner 送出空的 diff 並進入 Review Gate；人在 Gate 上看到錯誤的文字，選「結束（沒有變更）」後
// Task 轉 Done，Run 以 cancel 結束，分支沒有 push 到 bare repo。
// 劇本與全域的那組（m1.yaml）不同，所以這個檔案自己啟動一組 stack 與 Vite。

import { execFileSync } from "node:child_process";
import { API_ROUTES, apiPath, Run, Task } from "@orbis/api-contract";
import { expect, test } from "@playwright/test";
import { freePort, type StartedStack, type StartedWeb, startStack, startWeb } from "./stack";

/** empty-diff.yaml 的回覆。 */
const MODEL_ERROR = "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.";

let stack: StartedStack;
let web: StartedWeb;
let baseURL: string;

test.describe("Review Gate 的 diff 為空（完整系統）", () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000);
    const serverPort = await freePort();
    const webPort = await freePort();
    baseURL = `http://localhost:${webPort}`;
    stack = await startStack(serverPort, baseURL, {
      agentScript: "empty-diff.yaml",
      logPrefix: "empty-diff-",
    });
    web = await startWeb(webPort, serverPort, "empty-diff-");
  });

  test.afterAll(async () => {
    await web?.stop();
    await stack?.stop();
  });

  test("Agent 沒有改檔 → Review Gate 顯示最後的回覆 → 結束（沒有變更）→ Task Done、沒有 push", async ({
    browser,
  }) => {
    const ready = stack.ready;
    const context = await browser.newContext({ baseURL });
    await context.addCookies([{ ...ready.sessionCookie, url: baseURL }]);
    const page = await context.newPage();
    const request = context.request;
    const headers = { origin: baseURL };

    // 只回答問題的 Task：一條 manual 條件，由人確認回覆
    const created = await request.post(
      apiPath(API_ROUTES.projectTasks, { projectId: ready.projectId }),
      {
        headers,
        data: {
          repoId: ready.repoId,
          title: "B5：回答登入頁需不需要修改",
          description: "只要回答，不需要修改檔案。",
        },
      },
    );
    const task = Task.parse(await created.json());
    await request.post(apiPath(API_ROUTES.taskAcceptanceCriteria, { taskId: task.id }), {
      headers,
      data: { kind: "manual", description: "回覆內容正確" },
    });

    await page.goto(`/tasks/${task.key}`);
    await page.locator(".wk-norun").getByRole("button", { name: "移到就緒" }).click();
    await page.getByRole("form", { name: "派工" }).getByRole("button", { name: "派工" }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.key}[?]run=[^&]+$`));
    const runId = new URL(page.url()).searchParams.get("run") ?? "";
    await expect(page.getByTestId("run-status")).toHaveText("等待審查關卡", { timeout: 120_000 });

    // 審查關卡：diff 為空，看得到 Agent 最後的回覆，沒有「核准並開啟合併請求」
    await page.getByRole("button", { name: "開啟差異審查" }).click();
    const empty = page.getByRole("region", { name: "沒有變更" });
    await expect(empty.getByTestId("final-message")).toHaveText(MODEL_ERROR);
    await expect(page.getByRole("button", { name: "核准並開啟合併請求" })).toHaveCount(0);
    const finish = page.getByRole("button", { name: "結束（沒有變更）" });
    await expect(finish).toBeDisabled();
    await page.getByRole("checkbox", { name: "回覆內容正確" }).check();
    await finish.click();
    await expect(page.getByTestId("run-status")).toHaveText("已中止", { timeout: 60_000 });

    const taskResponse = await request.get(apiPath(API_ROUTES.task, { taskId: task.id }));
    expect(Task.parse(await taskResponse.json())).toMatchObject({
      status: "done",
      doneReason: "completed",
    });
    const runResponse = await request.get(apiPath(API_ROUTES.run, { runId }));
    const run = Run.parse(await runResponse.json());
    expect(run.status).toBe("canceled");
    // 分支沒有 push 到 remote（本機的 bare repo）
    expect(run.branch).not.toBeNull();
    const refs = execFileSync("git", ["for-each-ref", `refs/heads/${run.branch}`], {
      cwd: ready.bareRepoPath,
      encoding: "utf8",
    });
    expect(refs.trim()).toBe("");

    await page.getByRole("tab", { name: /任務/ }).click();
    await expect(page.locator(".rp-status")).toHaveText("完成");
    await context.close();
  });
});
