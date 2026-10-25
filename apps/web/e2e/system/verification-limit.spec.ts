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
    await page.locator(".wk-norun").getByRole("button", { name: "移到就緒" }).click();
    await page.getByRole("form", { name: "派工" }).getByRole("button", { name: "派工" }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.key}[?]run=[^&]+$`));
    return { task, runId: new URL(page.url()).searchParams.get("run") ?? "" };
  }

  /** 任務分頁驗收紀錄中，超過重試上限時的決定表單。 */
  const decision = (page: Page) =>
    page
      .getByTestId("verification-section")
      .getByRole("form", { name: /驗收連續失敗 \d+ 輪，超過重試上限/ });

  /** 第一次執行 Verification 的指令前問人（不在 allow_commands 中），然後兩輪都失敗、停下來。 */
  async function untilStopped(page: Page): Promise<void> {
    const timeline = page.getByTestId("timeline");
    const permission = timeline.locator('.st-perm[data-resolved="false"]');
    await expect(permission).toContainText(VERIFY_COMMAND, { timeout: 120_000 });
    await permission.getByRole("button", { name: "允許一次" }).click();
    const rounds = timeline.locator(".st-verify");
    await expect(rounds).toHaveCount(2, { timeout: 120_000 });
    await expect(timeline).toContainText("驗收重試");
    await expect(rounds.nth(1).locator(".st-glyph").first()).toHaveText("✕", {
      timeout: 120_000,
    });
    // 到了上限：不再送回 Agent，等人決定
    await expect(decision(page)).toBeVisible();
    await expect(rounds).toHaveCount(2);
    await expect(page.locator(".cp-dock")).toContainText("驗收未通過");
    await expect(page.getByRole("button", { name: "開啟差異審查" })).toHaveCount(0);
  }

  test("兩輪失敗後停在 Verifying；待我處理的「前往決定」開任務分頁的驗收紀錄；略過失敗 → Review Gate → 核准", async ({
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

    // 待我處理：停下來的 Run，一鍵直接開任務分頁的驗收紀錄（#53 的觀察）
    await page.goto("/needs-you");
    const stopped = page.locator('.ny-row[data-kind="stopped_run"]', { hasText: task.key });
    // 原因是 Server 給的文字（契約沒有原因代碼，UI 原樣顯示）
    await expect(stopped).toContainText("連續失敗 2 次");
    await stopped.getByRole("button", { name: "前往決定" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/tasks/${task.key}[?]run=${runId}&tab=task&focus=verification$`),
    );
    await expect(page.getByRole("tab", { name: "任務" })).toHaveAttribute("aria-selected", "true");
    const form = decision(page);
    await expect(form).toBeInViewport();
    await expect(form).toContainText("驗收連續失敗 2 輪，超過重試上限");
    // 兩輪的證據都在
    const second = page.getByTestId("verification-section").getByTestId("verification-2");
    const head = second.locator(".rp-round-head");
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
    await expect(second.locator('[data-evidence="command_output"]')).toContainText("結束碼 1");

    // 略過失敗：進入審查關卡，看得到失敗，人工確認打勾後才能核准
    await form.getByRole("button", { name: "略過失敗，進入審查關卡" }).click();
    await expect(form).toHaveCount(0);
    await page.getByRole("button", { name: "開啟差異審查" }).click({ timeout: 60_000 });
    const approve = page.getByRole("button", { name: "核准並開啟合併請求" });
    await expect(approve).toBeDisabled();
    await page.getByRole("checkbox", { name: "verify.txt 的內容正確" }).check();
    await approve.click();
    await expect(page.getByTestId("run-status")).toHaveText("已完成", { timeout: 60_000 });
    await page.getByRole("tab", { name: "任務" }).click();
    await expect(page.locator(".rp-status")).toHaveText("合併請求已開啟");
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

    // 直接以 ?tab=verification 開驗收紀錄（桌面通知點擊也是這個位置）
    await page.goto(`/runs/${runId}?tab=verification`);
    await expect(page.getByRole("tab", { name: "任務" })).toHaveAttribute("aria-selected", "true");
    const form = decision(page);
    await expect(form).toBeInViewport();
    await form.getByLabel("給代理的意見（選填）").fill("請改成 pass");
    await form.getByRole("button", { name: "附意見再試" }).click();
    await expect(form).toHaveCount(0);

    // Agent 收到意見後寫入 pass；新的一輪從 1 開始計算並通過
    const timeline = page.getByTestId("timeline");
    await expect(timeline).toContainText("收到意見，改成 pass。", { timeout: 120_000 });
    await expect(timeline.locator(".st-verify").last().locator(".st-glyph").first()).toHaveText(
      "✓",
      { timeout: 120_000 },
    );
    await expect(page.getByRole("button", { name: "開啟差異審查" })).toBeVisible();
    await expect(
      page.getByTestId("verification-section").getByTestId("verification-2").first(),
    ).toContainText("決定：附意見再試");
    await context.close();
  });
});
