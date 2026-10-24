// Verification 超過重試上限後人的三種決定之二（略過失敗、附意見再試），跑在完整系統上（M2 的完成條件，
// ARCHITECTURE §5.1「失敗重試」）。Fake Agent 用 verify-fail.yaml（兩輪都不寫 pass，附意見後才寫），
// Project 的重試上限設成 1，所以第 2 輪失敗後 Run 停在 Verifying、加入 Needs You。
// 這個檔案自己啟動一組 stack 與 Vite（全域的那組用 m1.yaml）。「中止」的決定在 mock 層與 Server 測試驗證。

import { API_ROUTES, apiPath, Task } from "@orbis/api-contract";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { freePort, type StartedStack, type StartedWeb, startStack, startWeb } from "./stack";

/** verify-fail.yaml 的 command 條件：只依賴 git，三種 shell 都不需要處理引號。 */
const VERIFY_COMMAND = "git grep --no-index -q pass verify.txt";

let stack: StartedStack;
let web: StartedWeb;
let baseURL: string;

test.describe("Verification 超過重試上限（完整系統）", () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000);
    const serverPort = await freePort();
    const webPort = await freePort();
    baseURL = `http://localhost:${webPort}`;
    stack = await startStack(serverPort, baseURL, {
      agentScript: "verify-fail.yaml",
      logPrefix: "verification-limit-",
    });
    web = await startWeb(webPort, serverPort, "verification-limit-");
    // 重試上限設成 1：第一輪之後只重試一次，第 2 輪失敗就停下
    const res = await fetch(
      `${stack.ready.serverUrl}${apiPath(API_ROUTES.project, { projectId: stack.ready.projectId })}`,
      {
        method: "PATCH",
        headers: {
          cookie: `${stack.ready.sessionCookie.name}=${stack.ready.sessionCookie.value}`,
          origin: baseURL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ policy: { verificationMaxRetries: 1 } }),
      },
    );
    expect(res.status, await res.text()).toBe(200);
  });

  test.afterAll(async () => {
    await web?.stop();
    await stack?.stop();
  });

  /** 建立有一條 command 條件與一條 manual 條件的 Task，派工到我的電腦，回傳 Task 與 Run ID。 */
  async function dispatchTask(
    page: Page,
    request: APIRequestContext,
    title: string,
  ): Promise<{ task: Task; runId: string }> {
    const ready = stack.ready;
    const headers = { origin: baseURL };
    const created = await request.post(
      apiPath(API_ROUTES.projectTasks, { projectId: ready.projectId }),
      {
        headers,
        data: { repoId: ready.repoId, title, description: "新增 verify.txt，內容是 pass。" },
      },
    );
    const task = Task.parse(await created.json());
    const criteria = apiPath(API_ROUTES.taskAcceptanceCriteria, { taskId: task.id });
    await request.post(criteria, {
      headers,
      data: { kind: "command", description: "verify.txt 是 pass", command: VERIFY_COMMAND },
    });
    await request.post(criteria, {
      headers,
      data: { kind: "manual", description: "verify.txt 的內容正確" },
    });

    await page.goto(`/tasks/${task.key}`);
    await page.locator(".ready-panel").getByRole("button", { name: "移到 Ready" }).click();
    await page.getByRole("button", { name: "派工" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "派工" }).click();
    await expect(page).toHaveURL(/\/runs\/[^/?]+$/);
    return { task, runId: page.url().split("/").pop() ?? "" };
  }

  /** 第一次執行 Verification 的指令前問人（不在 allow_commands 中），然後兩輪都失敗、停下來。 */
  async function untilStopped(page: Page): Promise<void> {
    const timeline = page.getByTestId("timeline");
    const permission = timeline.locator('.event-permission[data-resolved="false"]');
    await expect(permission).toContainText(VERIFY_COMMAND, { timeout: 120_000 });
    await permission.getByRole("button", { name: "允許這次" }).click();
    await expect(timeline).toContainText("第 1 輪 Verification 結束：失敗", { timeout: 120_000 });
    await expect(timeline).toContainText("送出 prompt（Verification 重試）");
    await expect(timeline).toContainText("第 2 輪 Verification 結束：失敗", { timeout: 120_000 });
    // 到了上限：不再送回 Agent，等人決定
    await expect(timeline).not.toContainText("第 3 輪 Verification");
    await expect(page.getByRole("link", { name: "Diff review" })).toHaveCount(0);
  }

  test("兩輪失敗後停在 Verifying；Needs You 的「前往 Run」開 Verification 分頁；略過失敗 → Review Gate → 核准", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL });
    await context.addCookies([{ ...stack.ready.sessionCookie, url: baseURL }]);
    const page = await context.newPage();
    const { task, runId } = await dispatchTask(
      page,
      context.request,
      "Verification 上限：略過失敗",
    );
    await untilStopped(page);

    // Needs You：停下來的 Run，一鍵直接開 Verification 分頁（#53 的觀察）
    await page.goto("/needs-you");
    const stopped = page.locator('.needs-you-item[data-kind="stopped_run"]', { hasText: task.key });
    await expect(stopped).toContainText("Verification 連續失敗 2 次");
    await stopped.getByRole("link", { name: "前往 Run" }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}\\?tab=verification$`));
    await expect(page.getByRole("tab", { name: "Verification" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const form = page.getByRole("form", { name: "Verification 的決定" });
    await expect(form).toBeVisible();
    await expect(form).toContainText("Verification 連續失敗 2 輪，超過重試上限");
    // 兩輪的證據都在
    const second = page.getByTestId("verification-2");
    await expect(second.locator('[data-evidence="command_output"]')).toContainText("exit code 1");

    // 略過失敗：進入 Review Gate，Review 頁看得到失敗，manual 打勾後才能核准
    await form.getByRole("button", { name: "略過失敗，進入 Review Gate" }).click();
    await expect(form).toHaveCount(0);
    await page.getByRole("link", { name: "Diff review" }).click({ timeout: 60_000 });
    const approve = page.getByRole("button", { name: "核准並開 PR" });
    await expect(approve).toBeDisabled();
    await page
      .getByRole("region", { name: "Acceptance Criterion" })
      .getByRole("checkbox", { name: "verify.txt 的內容正確" })
      .check();
    await approve.click();
    await expect(page.getByTestId("run-status")).toHaveText("已完成", { timeout: 60_000 });
    await page.goto(`/tasks/${task.key}`);
    await expect(page.locator(".page-header .status-badge")).toHaveText("PR Open");
    await context.close();
  });

  test("附意見再試：意見送回 Agent，重試次數重新計算，新的一輪通過後進入 Review Gate", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL });
    await context.addCookies([{ ...stack.ready.sessionCookie, url: baseURL }]);
    const page = await context.newPage();
    const { runId } = await dispatchTask(page, context.request, "Verification 上限：附意見再試");
    await untilStopped(page);

    // 直接以 ?tab=verification 開 Verification 分頁（桌面通知點擊也是這個位置）
    await page.goto(`/runs/${runId}?tab=verification`);
    const form = page.getByRole("form", { name: "Verification 的決定" });
    await expect(form).toBeVisible();
    await form.getByLabel("給 Agent 的意見（選填）").fill("請改成 pass");
    await form.getByRole("button", { name: "附意見再試" }).click();
    await expect(form).toHaveCount(0);

    // Agent 收到意見後寫入 pass；新的一輪從 1 開始計算並通過
    await page.getByRole("tab", { name: "時間軸" }).click();
    const timeline = page.getByTestId("timeline");
    await expect(timeline).toContainText("收到意見，改成 pass。", { timeout: 120_000 });
    await expect(timeline).toContainText("第 1 輪 Verification 結束：通過", { timeout: 120_000 });
    await expect(page.getByRole("link", { name: "Diff review" })).toBeVisible();
    await page.getByRole("tab", { name: "Verification" }).click();
    await expect(page.getByTestId("verification-2").first()).toContainText("人的決定：附意見再試");
    await context.close();
  });
});
