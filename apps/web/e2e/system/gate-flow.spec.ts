// C2 的完成條件跑在完整系統上：Plan Gate → Verification 失敗後重試 → 通過 → manual 打勾 → 核准。
// Fake Agent 用 plan-verify.yaml（A2），所以這個檔案自己啟動一組 stack 與 Vite（全域的那組用 m1.yaml）。
//
// TODO(A2, #30): 等 A2 的 plan-verify.yaml（與 Verification 指令經過 Permission Policy）合併後，
// 由 A2 在它的 PR 中拿掉 fixme 並跑通。B2 的 Server 端（Plan Gate、Verification、manual 打勾）已合併。

import { API_ROUTES, apiPath, Task } from "@orbis/api-contract";
import { expect, test } from "@playwright/test";
import { freePort, type StartedStack, type StartedWeb, startStack, startWeb } from "./stack";

/** plan-verify.yaml 的 command 條件：只依賴 git，三種 shell 都不需要處理引號。 */
const VERIFY_COMMAND = "git grep --no-index -q pass verify.txt";

let stack: StartedStack;
let web: StartedWeb;
let baseURL: string;

test.describe("Plan Gate 到核准（完整系統）", () => {
  test.fixme(true, "TODO(A2, #30)：等 A2 的 plan-verify.yaml 合併");

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
    await page.locator(".ready-panel").getByRole("button", { name: "移到 Ready" }).click();
    await page.getByRole("button", { name: "派工" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "派工" }).click();
    await expect(page).toHaveURL(/\/runs\/[^/?]+$/);

    // Plan Gate
    const plan = page.getByRole("region", { name: "Plan Gate：等待核准 plan" });
    await expect(plan.getByTestId("plan-body")).toContainText("新增 verify.txt");
    await plan.getByRole("button", { name: "核准 plan" }).click();
    await expect(plan).toHaveCount(0);

    // Verification 的指令不在 allow_commands 中：第一次執行前問人
    const timeline = page.getByTestId("timeline");
    const permission = timeline.locator('.event-permission[data-resolved="false"]');
    await expect(permission).toContainText(VERIFY_COMMAND, { timeout: 120_000 });
    await permission.getByRole("button", { name: "允許這次" }).click();

    // 第一輪失敗，自動重試後第二輪通過
    await expect(timeline).toContainText("第 1 輪 Verification 結束：失敗", { timeout: 120_000 });
    await expect(timeline).toContainText("送出 prompt（Verification 重試）");
    await expect(timeline).toContainText("第 2 輪 Verification 結束：通過", { timeout: 120_000 });
    await page.getByRole("tab", { name: "Verification" }).click();
    const first = page.getByTestId("verification-1");
    await expect(first.locator('[data-evidence="command_output"]')).toContainText(VERIFY_COMMAND);
    await expect(first.locator('[data-evidence="command_output"]')).toContainText("exit code 1");

    // Review Gate：manual 打勾後核准
    await page.getByRole("link", { name: "Diff review" }).click();
    const approve = page.getByRole("button", { name: "核准並開 PR" });
    await expect(approve).toBeDisabled();
    await page
      .getByRole("region", { name: "Acceptance Criterion" })
      .getByRole("checkbox", { name: "verify.txt 的內容正確" })
      .check();
    await approve.click();
    await expect(page.getByTestId("run-status")).toHaveText("已完成", { timeout: 60_000 });
    await context.close();
  });
});
