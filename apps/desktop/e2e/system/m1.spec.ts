// Electron 版的 M1 路徑（90 Integration 的完成條件）：真實 Server + Postgres + Web UI + Fake Agent（m1.yaml），
// Local Runner 由 Desktop 的 sidecar 自己 Pairing。
//
// 1. `e2e:stack --runner-config-out <runnerHome>` 建立種子資料與 runner.toml，但不啟動 Runner。
// 2. Vite 以空的 port 啟動、proxy 到 stack 的 Server。
// 3. Electron 以獨立的 userData 啟動，Server URL 是 Web origin，Runner 本機目錄的環境變數
//    （`NAMES.runnerEnv.home`）設成 <runnerHome>；sidecar 繼承它，讀 stack 寫的 runner.toml。
// 4. 把 ready 行的 session cookie 設到 Electron session 的 Web origin 上，就是已登入的狀態。
// 5. 在 Electron 視窗中操作 Web UI 走完 M1，最後送 merged webhook，Task 轉為 Done。
// 結束時關閉 Electron、Vite、stack，確認自己啟動的程序樹都已結束。

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_ROUTES, apiPath, Run, Runner } from "@orbis/api-contract";
import { NAMES } from "@orbis/api-contract/names";
import { type ReadyLine, sendPullRequestMergedWebhook } from "@orbis/server/e2e";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type Desktop, launchDesktop, waitUntil } from "../fixtures/desktop";
import {
  freePort,
  LOG_DIR,
  ProcessLedger,
  type StartedStack,
  type StartedWeb,
  startStack,
  startWeb,
} from "./stack";

// 整條 M1 路徑只有一組種子資料與一台 Runner，依序執行
test.describe.configure({ mode: "serial" });

let runnerHome: string;
let stack: StartedStack | undefined;
let web: StartedWeb | undefined;
let desktop: Desktop | undefined;
let ready: ReadyLine;
let webOrigin: string;
const ledger = new ProcessLedger();

/** 記下 stack、Vite、Electron 目前的程序樹。 */
function recordProcesses(): void {
  ledger.record(stack?.pid);
  ledger.record(web?.pid);
  ledger.record(desktop?.app.process().pid);
}

/** 以 ready 行的 session cookie 直接呼叫 stack 的 Server。 */
async function serverGet(path: string): Promise<unknown> {
  const res = await fetch(`${ready.serverUrl}${path}`, {
    headers: { cookie: `${ready.sessionCookie.name}=${ready.sessionCookie.value}` },
  });
  if (!res.ok) throw new Error(`GET ${path} 回應 ${res.status}`);
  return res.json();
}

test.beforeAll(async () => {
  // 第一次執行 migration、啟動 Vite 都可能比較久
  test.setTimeout(600_000);
  runnerHome = mkdtempSync(join(tmpdir(), "desktop-system-e2e-"));
  const serverPort = await freePort();
  const webPort = await freePort();
  webOrigin = `http://localhost:${webPort}`;
  stack = await startStack({ serverPort, webOrigin, runnerHome });
  ready = stack.ready;
  expect(ready.runnerId).toBeNull();
  expect(existsSync(join(runnerHome, NAMES.runnerConfigFile))).toBe(true);
  web = await startWeb(webPort, serverPort);
  desktop = await launchDesktop({
    config: { serverUrl: webOrigin },
    env: { [NAMES.runnerEnv.home]: runnerHome },
  });
  recordProcesses();
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  recordProcesses();
  const runnerLog = desktop ? await desktop.hooks((h) => h.runnerLogPath).catch(() => null) : null;
  // 不用 desktop.close()：它會刪掉 userData，Runner log 要先複製出來給 CI 上傳（含結束時的紀錄）
  await desktop?.app.close();
  if (runnerLog && existsSync(runnerLog)) copyFileSync(runnerLog, join(LOG_DIR, "runner.log"));
  if (desktop) {
    rmSync(desktop.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  await web?.stop();
  const code = await stack?.stop();
  // 給作業系統一點時間回收程序
  await new Promise((r) => setTimeout(r, 1_000));
  const leftovers = ledger.alive();
  rmSync(runnerHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  expect(code, "e2e:stack 沒有正常結束").toBe(0);
  expect(ledger.size).toBeGreaterThan(0);
  expect(leftovers, "結束後仍有殘留的程序（自己啟動的程序樹）").toEqual([]);
  console.log(`自己啟動的 ${ledger.size} 個程序（stack、Vite、Electron 與其子孫）都已結束`);
});

/** 用滑鼠把 Task 卡片拖到看板分欄檢視的某一欄（dnd-kit 需要中間的移動事件）。 */
async function dragCard(page: Page, taskKey: string, status: string): Promise<void> {
  const from = await page.locator(`[data-task-key="${taskKey}"]`).boundingBox();
  const to = await page.locator(`.bd-column[data-status="${status}"]`).boundingBox();
  if (!from || !to) throw new Error("找不到要拖曳的元素");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 5 });
  // 欄位可能有一部分在視窗外（左側有側欄）：目標點取欄位在視窗內的部分，視窗外的指標事件在 Windows 收不到
  const viewport = page.viewportSize();
  const x = Math.min(to.x + to.width / 2, (viewport?.width ?? to.x + to.width) - 10);
  await page.mouse.move(Math.max(to.x + 10, x), to.y + 60, { steps: 15 });
  await page.mouse.up();
}

test("Electron 中走完 M1：登入 → 自動 Pairing → 派工到我的電腦 → 權限請求 → diff 留言退回 → 核准 → PR Open → merge 後 Done", async () => {
  test.setTimeout(300_000);
  if (!desktop) throw new Error("Desktop 沒有啟動");
  const d = desktop;
  const page = await d.mainWindow();
  // 和 Web 的完整系統 e2e 相同的 viewport（1280×720），看板的 Ready 與 Running 欄要同時在畫面內才拖得過去。
  // 用模擬的 viewport，不調整視窗：CI 的螢幕比較小時，作業系統會把視窗限制在螢幕大小內
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(await page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([1280, 720]);

  // ---- 登入：把 stack 的 session cookie 設到 Electron session 的 Web origin 上
  await d.app.evaluate(
    ({ session }, { url, name, value }) =>
      session.defaultSession.cookies.set({ url, name, value, httpOnly: true, sameSite: "lax" }),
    { url: webOrigin, ...ready.sessionCookie },
  );

  // ---- 自動 Pairing：系統匣顯示已連線，Server 上有這個 Member 的 Local Runner
  await waitUntil(
    () => d.hooks((h) => h.tray().statusLabel),
    (label) => label === "已連線",
    "系統匣顯示已連線",
    60_000,
  );
  const sidecar = await d.hooks((h) => h.sidecar());
  expect(sidecar.status?.state).toBe("connected");
  const runnerId = sidecar.status?.runner_id;
  expect(runnerId).toBeTruthy();
  const runners = z.array(Runner).parse(await serverGet(API_ROUTES.runners));
  const local = runners.find((r) => r.id === runnerId);
  expect(local?.kind).toBe("local");
  expect(local?.memberId).toBe(ready.memberId);
  await expect
    .poll(async () => {
      const list = z.array(Runner).parse(await serverGet(API_ROUTES.runners));
      const runner = list.find((r) => r.id === runnerId);
      return Boolean(runner?.online && runner.agents.some((a) => a.available));
    }, "Local Runner 在線並回報 Agent 可用")
    .toBe(true);
  recordProcesses();

  // ---- 建立 Task（描述與 Acceptance Criterion 是進入 Ready 的條件）
  await page.goto(`${webOrigin}/board`);
  await page
    .getByRole("button", { name: /^新增(任務| Task)$/ })
    .first()
    .click();
  const create = page.getByRole("dialog", { name: "新增任務" });
  await create.getByRole("textbox", { name: "任務標題" }).fill("M1：新增 m1.txt（Desktop）");
  await create.getByRole("textbox", { name: "描述要做什麼" }).fill("新增 `m1.txt`。");
  await create.getByRole("button", { name: /^建立並開啟/ }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${ready.projectKey}-\\d+$`));
  const taskKey = page.url().split("/").pop() ?? "";

  // 在任務分頁的內嵌編輯新增一條人工確認的條件
  await page.getByRole("tabpanel").getByRole("button", { name: "編輯", exact: true }).click();
  await page.getByRole("button", { name: "新增條件" }).click();
  const draft = page.locator(".rp-draft").last();
  await draft.getByLabel("條件描述").fill("m1.txt 存在");
  await draft.getByRole("button", { name: /條件類型/ }).click();
  await page.getByRole("menuitemradio", { name: /人工/ }).click();
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(page.locator(".rp-criterion")).toHaveCount(1);

  // ---- 看板（分欄）：待辦 → 就緒，再拖到執行中開派工對話框，派工到本機
  await page.goto(`${webOrigin}/board`);
  await page.getByRole("radio", { name: "分欄" }).click();
  await dragCard(page, taskKey, "ready");
  await expect(page.locator(`[data-status="ready"] [data-task-key="${taskKey}"]`)).toBeVisible();
  await dragCard(page, taskKey, "running");
  const dispatch = page.getByRole("dialog", { name: `派工 ${taskKey}` });
  await expect(dispatch.getByRole("radio", { name: /^我的電腦/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(dispatch.getByRole("radio", { name: /claude-code/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // Project 的預設政策是 manual，寫檔權限請求一定會出現
  await expect(dispatch.getByRole("radio", { name: "逐一確認" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await dispatch.getByRole("button", { name: "派工" }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskKey}[?]run=[^&]+$`));
  const runId = new URL(page.url()).searchParams.get("run") ?? "";

  // ---- 即時 Event：工作樹建好、Agent 請求寫檔權限
  const timeline = page.getByTestId("timeline");
  await expect(timeline).toContainText("工作樹已就緒");
  await expect(timeline).toContainText("我要新增 m1.txt。");
  const request = timeline.locator('.st-perm[data-resolved="false"]');
  await expect(request).toContainText("新增 m1.txt");
  await expect(page.getByTestId("needs-you-count")).toBeVisible();
  // Agent 正在等權限回覆：記下 sidecar 底下的 Agent 程序
  recordProcesses();
  expect((await d.hooks((h) => h.sidecar())).status?.active_runs).toBe(1);

  // ---- 回覆權限請求
  await request.getByRole("button", { name: "允許一次", exact: true }).click();
  await expect(timeline.locator('.st-perm[data-resolved="true"]')).toHaveCount(1);
  await expect(timeline).toContainText("已新增 m1.txt。");

  // ---- 第一回合結束，進入審查關卡；在差異分頁留言退回
  await expect(page.getByTestId("run-status")).toHaveText("等待審查關卡");
  await expect(timeline).toContainText("已產生審查差異");
  await page.getByRole("tab", { name: /差異/ }).click();
  await page
    .locator(".rp-file-tabs")
    .getByRole("button", { name: /m1\.txt/ })
    .click();
  await expect(page.locator(".rp-file")).toContainText("version 1");
  // M1 劇本要求退回的 prompt 含「改成第二版」
  await page.getByRole("button", { name: "對修改後第 1 行留言", exact: true }).click();
  await page.getByRole("combobox", { name: "對修改後第 1 行留言" }).fill("請改成第二版");
  await page.getByRole("button", { name: "加入留言" }).click();
  await page.getByRole("button", { name: "退回（1）" }).click();

  // ---- 第二回合跑完後核准
  await expect(timeline).toContainText("已改成第二版。");
  await expect(page.getByTestId("run-status")).toHaveText("等待審查關卡");
  recordProcesses();
  await page
    .locator(".rp-file-tabs")
    .getByRole("button", { name: /m1\.txt/ })
    .click();
  await expect(page.locator(".rp-file")).toContainText("version 2");
  // 人工確認的條件全部打勾後才能核准
  const approve = page.getByRole("button", { name: "核准並開啟合併請求" });
  await expect(approve).toBeDisabled();
  await page.getByRole("checkbox", { name: "m1.txt 存在" }).check();
  await approve.click();
  await expect(page.getByTestId("run-status")).toHaveText("已完成", { timeout: 60_000 });

  // push 到本機 bare repo 的是第二版
  const run = Run.parse(await serverGet(apiPath(API_ROUTES.run, { runId })));
  const branch = run.branch;
  if (!branch) throw new Error("Run 完成後沒有 branch");
  const pushed = execFileSync("git", ["-C", ready.bareRepoPath, "show", `${branch}:m1.txt`], {
    encoding: "utf8",
  });
  expect(pushed).toBe("version 2\n");

  // ---- PR Open
  await page.getByRole("tab", { name: /任務/ }).click();
  await expect(page.locator(".rp-status")).toHaveText("合併請求已開啟");
  await page.goto(`${webOrigin}/board`);
  await expect(page.locator(`[data-status="pr_open"] [data-task-key="${taskKey}"]`)).toBeVisible();

  // ---- 在 GitHub 上 merge（以 merged webhook 模擬）→ Task 轉為 Done，看板與 Task 頁都看得到
  const merged = await sendPullRequestMergedWebhook(ready, { branch });
  expect(merged.status).toBe(200);
  await expect(async () => {
    await page.goto(`${webOrigin}/board`);
    await expect(page.locator(`[data-status="done"] [data-task-key="${taskKey}"]`)).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
  await page.goto(`${webOrigin}/tasks/${taskKey}`);
  await expect(page.locator(".rp-status")).toHaveText("完成");
  recordProcesses();
});
