// Delegation 跑在完整系統上（M2 的完成條件，ARCHITECTURE §9）：父 Run 的 Agent 以 Orbis MCP 的 delegate
// 各開一個 consult 與 branch 模式的 Child Run，Task 頁的 Run 樹顯示它們的 Agent、模式與狀態。
// stack 多註冊第二個 Agent `fake-child`（deleg-child.yaml），父 Run 用 deleg-parent.yaml。
// 這個檔案自己啟動一組 stack 與 Vite（全域的那組用 m1.yaml）。

import { API_ROUTES, apiPath, DispatchOptions, Run, Task } from "@orbis/api-contract";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { freePort, type StartedStack, type StartedWeb, startStack, startWeb } from "./stack";

let stack: StartedStack;
let web: StartedWeb;
let baseURL: string;

test.describe("Delegation（完整系統）", () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000);
    const serverPort = await freePort();
    const webPort = await freePort();
    baseURL = `http://localhost:${webPort}`;
    stack = await startStack(serverPort, baseURL, {
      agentScript: "deleg-parent.yaml",
      childAgentScript: "deleg-child.yaml",
      logPrefix: "delegation-",
    });
    web = await startWeb(webPort, serverPort, "delegation-");
  });

  test.afterAll(async () => {
    await web?.stop();
    await stack?.stop();
  });

  test("父 Run 以 delegate 開出 consult 與 branch 的 Child Run，Run 樹顯示 Agent、模式與狀態，點節點看即時檢視", async ({
    browser,
  }) => {
    const ready = stack.ready;
    expect(ready.childAgent).toBe("fake-child");
    const context = await browser.newContext({ baseURL });
    await context.addCookies([{ ...ready.sessionCookie, url: baseURL }]);
    const page = await context.newPage();
    const request = context.request;
    const headers = { origin: baseURL };

    // Runner 回報兩個 Agent 都可用（Child Run 一律派給父 Run 所在的 Runner，它要有 fake-child）
    await expect
      .poll(
        async () => {
          const res = await request.get(
            apiPath(API_ROUTES.projectDispatchOptions, { projectId: ready.projectId }),
          );
          const options = DispatchOptions.parse(await res.json());
          return options.local?.agents.filter((a) => a.available).map((a) => a.id) ?? [];
        },
        { timeout: 60_000 },
      )
      .toEqual(expect.arrayContaining(["claude-code", "fake-child"]));

    // 建立 Task 並派工給 claude-code（父 Run）
    const created = await request.post(
      apiPath(API_ROUTES.projectTasks, { projectId: ready.projectId }),
      {
        headers,
        data: {
          repoId: ready.repoId,
          title: "Delegation：consult 與 branch",
          description: "請 fake-child 看 README，並開子分支。",
        },
      },
    );
    const task = Task.parse(await created.json());
    await request.post(apiPath(API_ROUTES.taskAcceptanceCriteria, { taskId: task.id }), {
      headers,
      data: { kind: "manual", description: "parent.txt 存在" },
    });
    await request.post(apiPath(API_ROUTES.taskTransition, { taskId: task.id }), {
      headers,
      data: { status: "ready" },
    });
    const dispatched = await request.post(apiPath(API_ROUTES.taskRuns, { taskId: task.id }), {
      headers,
      data: { agent: "claude-code", runnerKind: "local", permissionPolicy: "manual" },
    });
    const parent = Run.parse(await dispatched.json());

    // Task 頁的 Run 樹：父 Run 底下兩個 Child Run（Agent 是 fake-child、來源 Delegation、各自的模式）
    await page.goto(`/tasks/${task.key}`);
    const tree = page.getByRole("list", { name: "Run 與 Child Run" });
    await expect(tree.locator(".run-node")).toHaveCount(3, { timeout: 120_000 });
    const children = tree.locator(`[data-run-id="${parent.id}"] .run-node[data-depth="1"]`);
    await expect(children).toHaveCount(2);
    const consult = children.filter({ hasText: "consult（唯讀）" });
    const branch = children.filter({ hasText: "branch（子分支）" });
    await expect(consult).toHaveCount(1);
    await expect(branch).toHaveCount(1);
    for (const child of [consult, branch]) {
      await expect(child.locator("> .run-node-row")).toContainText("fake-child");
      await expect(child.locator("> .run-node-row")).toContainText("Delegation");
      // Child Run 不經過 Review Gate，回合結束就完成
      await expect(child.locator("> .run-node-row .status-badge")).toHaveText("已完成", {
        timeout: 120_000,
      });
    }
    // 父 Run 結束回合後進入 Review Gate；Child Run 的狀態不會改變 Task 的狀態
    await expect(
      tree.locator(`[data-run-id="${parent.id}"] > .run-node-row .status-badge`),
    ).toHaveText("等待 Gate", { timeout: 120_000 });
    await expect(page.locator(".page-header .status-badge")).toHaveText("Review Gate");

    // 點 consult 的節點：即時檢視顯示 Child Run 的回覆
    const consultId = (await consult.getAttribute("data-run-id")) ?? "";
    await consult.locator("> .run-node-row").getByRole("button", { name: consultId }).click();
    const live = page.getByRole("region", { name: `Run ${consultId} 的即時檢視` });
    await expect(live.getByTestId("timeline")).toContainText("我是 Child Run");

    // API：Child Run 的 parentRunId、模式與分支（branch 模式是父分支加上 --c<n>）
    const listed = z
      .array(Run)
      .parse(await (await request.get(apiPath(API_ROUTES.taskRuns, { taskId: task.id }))).json());
    const childRuns = listed.filter((r) => r.parentRunId === parent.id);
    expect(childRuns.map((r) => r.delegationMode).sort()).toEqual(["branch", "consult"]);
    expect(childRuns.every((r) => r.origin === "delegation" && r.agent === "fake-child")).toBe(
      true,
    );
    const branchRun = childRuns.find((r) => r.delegationMode === "branch");
    // 子分支是父分支加上 --c<n>，n 依 Child Run 的順序編號（consult 先開，branch 是第 2 個）
    expect(branchRun?.branch).toBe(`${parent.branch}--c2`);

    // 父 Run 的 diff 只有它自己改的檔案
    await page.getByRole("link", { name: "開啟 Run 頁" }).first().click();
    await page.getByRole("link", { name: "Diff review" }).click();
    await expect(
      page.locator(".file-list").getByRole("button", { name: /parent\.txt/ }),
    ).toBeVisible();
    await context.close();
  });
});
