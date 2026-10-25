// C2 的完成條件跑在完整系統上：Plan Gate → Verification 失敗後重試 → 通過 → manual 打勾 → 核准。
// Fake Agent 用 plan-verify.yaml（A2），所以這個檔案自己啟動一組 stack 與 Vite（全域的那組用 m1.yaml）。

import { API_ROUTES, apiPath, Task } from "@orbis/api-contract";
import { expect, test } from "@playwright/test";
import { freePort, type StartedStack, type StartedWeb, startStack, startWeb } from "./stack";

/** plan-verify.yaml 的 command 條件：只依賴 git，三種 shell 都不需要處理引號。 */
const VERIFY_COMMAND = "git grep --no-index -q pass verify.txt";

let stack: StartedStack;
let web: StartedWeb;
let baseURL: string;

test.describe("Plan Gate 到核准（完整系統）", () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000);
    const serverPort = await freePort();
    const webPort = await freePort();
    baseURL = `http://localhost:${webPort}`;
    stack = await startStack(serverPort, baseURL, {
      agentScript: "plan-verify.yaml",
      logPrefix: "gate-flow-",
    });
    web = await startWeb(webPort, serverPort, "gate-flow-");
  });

  test.afterAll(async () => {
    await web?.stop();
    await stack?.stop();
  });

  test("Plan Gate → Verification 失敗後重試 → 通過 → manual 打勾 → 核准", async ({ browser }) => {
    const ready = stack.ready;
    const context = await browser.newContext({ baseURL });
    await context.addCookies([{ ...ready.sessionCookie, url: baseURL }]);
    const page = await context.newPage();
    const request = context.request;
    const headers = { origin: baseURL };

    // 準備 Task：一條 command 條件、一條 manual 條件，這個 Task 開啟 Plan Gate
    const created = await request.post(
      apiPath(API_ROUTES.projectTasks, { projectId: ready.projectId }),
      {
        headers,
        data: {
          repoId: ready.repoId,
          title: "C2：Plan Gate 到核准",
          description: "新增 verify.txt，內容是 pass。",
          planGateEnabled: true,
        },
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
    const timeline = page.getByTestId("timeline");

    // 計畫關卡：事件串流顯示待核准的計畫
    const plan = timeline.locator('.st-plan[data-pending="true"]');
    await expect(plan.getByTestId("plan-body")).toContainText("新增 verify.txt");

    // 通知中心（§12.3）：Gate 等待核准的通知經由 /api/ws 即時送到，標頭顯示未讀數；
    // 列表中點擊前往通知指向的 Task 頁並標為已讀，再回到 Run 頁
    const runUrl = page.url();
    await expect(page.getByTestId("notification-count")).toContainText("1");
    await page.getByRole("link", { name: /^通知/ }).click();
    await expect(page).toHaveURL(/\/notifications$/);
    const pending = page.locator(".notification", { hasText: `${task.key} 的 plan 等待核准` });
    await expect(pending).toHaveAttribute("data-read", "false");
    await pending.getByRole("button", { name: new RegExp(`${task.key} 的 plan 等待核准`) }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.key}$`));
    await expect(page.getByTestId("notification-count")).toHaveCount(0);
    await page.goto(runUrl);
    await expect(plan.getByTestId("plan-body")).toContainText("新增 verify.txt");

    await page.getByRole("button", { name: "核准計畫" }).click();
    await expect(plan).toHaveCount(0);

    // Verification 的指令不在 allow_commands 中：第一次執行前問人
    const permission = timeline.locator('.st-perm[data-resolved="false"]');
    await expect(permission).toContainText(VERIFY_COMMAND, { timeout: 120_000 });
    await permission.getByRole("button", { name: "允許一次" }).click();

    // 第一輪失敗，自動重試後第二輪通過
    const rounds = timeline.locator(".st-verify");
    await expect(rounds).toHaveCount(2, { timeout: 120_000 });
    await expect(rounds.nth(0).locator(".st-glyph").first()).toHaveText("✕");
    await expect(timeline).toContainText("驗收重試");
    await expect(rounds.nth(1).locator(".st-glyph").first()).toHaveText("✓", {
      timeout: 120_000,
    });
    // 任務分頁的驗收紀錄：第一輪的指令輸出
    const first = page.getByTestId("verification-section").getByTestId("verification-1");
    const head = first.locator(".rp-round-head");
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
    await expect(first.locator('[data-evidence="command_output"]')).toContainText(VERIFY_COMMAND);
    await expect(first.locator('[data-evidence="command_output"]')).toContainText("結束碼 1");

    // 審查關卡：人工確認打勾後核准
    await page.getByRole("button", { name: "開啟差異審查" }).click();
    const approve = page.getByRole("button", { name: "核准並開啟合併請求" });
    await expect(approve).toBeDisabled();
    await page.getByRole("checkbox", { name: "verify.txt 的內容正確" }).check();
    await approve.click();
    await expect(page.getByTestId("run-status")).toHaveText("已完成", { timeout: 60_000 });
    await context.close();
  });
});
