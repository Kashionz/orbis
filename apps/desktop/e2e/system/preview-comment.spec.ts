// Preview 留言的端到端（W5–7 延到 91 的項目，ARCHITECTURE §13、§10）：真實 Server + Postgres + Web UI +
// Desktop 的 sidecar Runner + Fake Agent（preview-comment.yaml），Repo 是一個最小的 Vite app。
//
// 1. `e2e:stack --runner-config-out` 建立種子資料，Server 設定 Preview 網域 `preview.localhost:<port>`。
// 2. 推 Vite app 與 `[preview]` 設定到 stack 的 bare repo；Electron 登入後 sidecar 自己 Pairing。
// 3. 以 API 建立 Task 並派工到我的電腦；核准設定檔的信任與權限請求，等到 preview_ready 與 Review Gate。
// 4. 在 Electron 的 Run 頁開 Preview 分頁：內嵌瀏覽器開 `localhost:<port>`（這台 Desktop 的 Local Runner 跑的 Run），
//    選取 `#app` 留言。留言的網址要換成這個 Run 的 Preview 網址（Server 只接受 Preview 網址，§10）。
// 5. Review 頁退回：Server 把 Preview 留言打包成 prompt（網址、selector、截圖以圖片附上），Runner 送給 Agent；
//    Fake Agent 的第二回合以 echo_prompt 回報收到的 prompt，從 Run 的 Event 驗證。
// 結束時關閉 Electron、Vite、stack，確認自己啟動的程序樹都已結束。

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { API_ROUTES, apiPath, Runner } from "@orbis/api-contract";
import { envVar, NAMES } from "@orbis/api-contract/names";
import type { ReadyLine } from "@orbis/server/e2e";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { type Desktop, launchDesktop, waitUntil } from "../fixtures/desktop";
import { previewTools } from "../fixtures/preview";
import {
  freePort,
  LOG_DIR,
  ProcessLedger,
  type StartedStack,
  type StartedWeb,
  startStack,
  startWeb,
} from "./stack";

test.describe.configure({ mode: "serial" });

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

let runnerHome: string;
let stack: StartedStack | undefined;
let web: StartedWeb | undefined;
let desktop: Desktop | undefined;
let ready: ReadyLine;
let webOrigin: string;
let serverPort: number;
const ledger = new ProcessLedger();

function recordProcesses(): void {
  ledger.record(stack?.pid);
  ledger.record(web?.pid);
  ledger.record(desktop?.app.process().pid);
}

/** 以 ready 行的 session cookie 呼叫 stack 的 Server API。 */
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ready.serverUrl}${path}`, {
    method,
    headers: {
      cookie: `${ready.sessionCookie.name}=${ready.sessionCookie.value}`,
      origin: webOrigin,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} 回應 ${res.status}：${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

interface RunEventRow {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
}

async function events(runId: string): Promise<RunEventRow[]> {
  const list = await api<{ seq: number; event: Record<string, unknown> }[]>(
    "GET",
    apiPath(API_ROUTES.runEvents, { runId }),
  );
  return list.map((e) => ({ seq: e.seq, kind: String(e.event.kind), payload: e.event }));
}

/** 推到 stack 的 bare repo：一個最小的 Vite app，`[preview]` 以 node 啟動 Vite。 */
function pushViteApp(): void {
  const vite = pathToFileURL(createRequire(import.meta.url).resolve("vite")).href;
  const work = mkdtempSync(join(tmpdir(), "preview-comment-e2e-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Preview E2E",
        GIT_AUTHOR_EMAIL: "preview-e2e@example.invalid",
        GIT_COMMITTER_NAME: "Preview E2E",
        GIT_COMMITTER_EMAIL: "preview-e2e@example.invalid",
      },
    });
  try {
    git("clone", ready.bareRepoPath, ".");
    const files: Record<string, string> = {
      "index.html":
        '<!doctype html><html><body><h1 id="app">preview</h1><button data-testid="save">儲存</button></body></html>\n',
      "preview.mjs": [
        `import { createServer } from ${JSON.stringify(vite)};`,
        "const server = await createServer({",
        "  root: process.cwd(),",
        "  configFile: false,",
        `  server: { port: Number(process.env.${NAMES.env.port}), strictPort: true },`,
        "});",
        "await server.listen();",
        "server.printUrls();",
        "",
      ].join("\n"),
      [`${NAMES.configDir}/${NAMES.configFile}`]:
        '[preview]\ncommand = "node preview.mjs"\nready_path = "/"\n',
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }
    git("add", "-A");
    git("commit", "-m", "加入 Preview 的 Vite app");
    git("push", "origin", "HEAD");
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

test.beforeAll(async () => {
  test.setTimeout(600_000);
  runnerHome = mkdtempSync(join(tmpdir(), "desktop-preview-comment-e2e-"));
  serverPort = await freePort();
  const webPort = await freePort();
  webOrigin = `http://localhost:${webPort}`;
  stack = await startStack({
    serverPort,
    webOrigin,
    runnerHome,
    env: {
      [envVar("PREVIEW_DOMAIN")]: `preview.localhost:${serverPort}`,
      [envVar("E2E_AGENT_SCRIPT")]: join(
        repoRoot,
        "crates",
        "fake-agent",
        "scripts",
        "preview-comment.yaml",
      ),
    },
  });
  ready = stack.ready;
  expect(ready.runnerId).toBeNull();
  pushViteApp();
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
  await desktop?.app.close();
  if (runnerLog && existsSync(runnerLog)) {
    copyFileSync(runnerLog, join(LOG_DIR, "preview-comment-runner.log"));
  }
  if (desktop) {
    rmSync(desktop.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  await web?.stop();
  const code = await stack?.stop();
  await new Promise((r) => setTimeout(r, 1_000));
  const leftovers = ledger.alive();
  rmSync(runnerHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  expect(code, "e2e:stack 沒有正常結束").toBe(0);
  expect(leftovers, "結束後仍有殘留的程序（自己啟動的程序樹）").toEqual([]);
});

test("在 Electron 的內嵌瀏覽器選取元素留言 → Review Gate 退回 → Agent 收到含 Preview 網址、selector 與截圖的 prompt", async () => {
  test.setTimeout(420_000);
  if (!desktop) throw new Error("Desktop 沒有啟動");
  const d = desktop;
  const page = await d.mainWindow();
  await page.setViewportSize({ width: 1280, height: 720 });

  // ---- 登入：把 stack 的 session cookie 設到 Electron session 的 Web origin 上；sidecar 自動 Pairing
  await d.app.evaluate(
    ({ session }, { url, name, value }) =>
      session.defaultSession.cookies.set({ url, name, value, httpOnly: true, sameSite: "lax" }),
    { url: webOrigin, ...ready.sessionCookie },
  );
  await waitUntil(
    () => d.hooks((h) => h.tray().statusLabel),
    (label) => label === "已連線",
    "系統匣顯示已連線",
    60_000,
  );
  const runnerId = (await d.hooks((h) => h.sidecar())).status?.runner_id;
  expect(runnerId).toBeTruthy();
  await expect
    .poll(async () => {
      const list = z.array(Runner).parse(await api("GET", API_ROUTES.runners));
      const runner = list.find((r) => r.id === runnerId);
      return Boolean(runner?.online && runner.agents.some((a) => a.available));
    }, "Local Runner 在線並回報 Agent 可用")
    .toBe(true);
  recordProcesses();

  // ---- 建立 Task，派工到我的電腦（這台 Desktop 的 sidecar）
  const task = await api<{ id: string; key: string }>(
    "POST",
    apiPath(API_ROUTES.projectTasks, { projectId: ready.projectId }),
    { repoId: ready.repoId, title: "Preview 留言", description: "修改首頁標題。" },
  );
  await api("POST", apiPath(API_ROUTES.taskAcceptanceCriteria, { taskId: task.id }), {
    kind: "manual",
    description: "標題正確",
  });
  await api("POST", apiPath(API_ROUTES.taskTransition, { taskId: task.id }), { status: "ready" });
  const run = await api<{ id: string }>("POST", apiPath(API_ROUTES.taskRuns, { taskId: task.id }), {
    agent: "claude-code",
    runnerKind: "local",
    permissionPolicy: "manual",
  });
  const runId = run.id;

  // ---- 核准設定檔的信任（Preview 指令）與權限請求，直到 Preview 就緒
  const answered = new Set<string>();
  const previewEvent = await waitUntil(
    async () => {
      const list = await events(runId);
      for (const event of list) {
        const requestId = event.payload.request_id as string | undefined;
        if (event.kind !== "permission_request" || !requestId || answered.has(requestId)) continue;
        const options = event.payload.options as { option_id: string; kind: string }[];
        const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
        answered.add(requestId);
        await api("POST", apiPath(API_ROUTES.runPermissionResponse, { runId, requestId }), {
          optionId: allow?.option_id,
        });
      }
      recordProcesses();
      return list.find((e) => e.kind === "preview_ready" || e.kind === "preview_stopped") ?? null;
    },
    (event) => event !== null,
    "preview_ready",
    180_000,
  );
  if (previewEvent?.kind === "preview_stopped") {
    const { reason, exit_code, output } = previewEvent.payload;
    throw new Error(`dev server 沒有就緒就停止（${reason}，結束碼 ${exit_code}）：\n${output}`);
  }
  const localUrl = String(previewEvent?.payload.url);
  expect(localUrl).toMatch(/^http:\/\/localhost:\d+\/$/);
  const shareOrigin = `http://${runId}.preview.localhost:${serverPort}`;

  // ---- 第一回合結束：Review Gate
  await page.goto(`${webOrigin}/runs/${runId}`);
  await expect(page.getByTestId("run-status")).toHaveText("等待關卡", { timeout: 120_000 });

  // ---- Preview 分頁：內嵌瀏覽器開 localhost；選取 #app 留言，留言的網址換成 Preview 網址
  await page.getByRole("tab", { name: "Preview" }).click();
  const preview = previewTools(d);
  await waitUntil(preview.url, (url) => url === localUrl, "內嵌瀏覽器開啟 localhost", 60_000);
  await page.getByRole("button", { name: "選取元素留言" }).click();
  await preview.waitForOverlay();
  await preview.click("#app");
  const form = page.getByRole("form", { name: "Preview 留言" });
  await expect(form).toBeVisible();
  await expect(form.locator("code")).toHaveText("#app");
  await expect(form).toContainText(`${shareOrigin}/`);
  await expect(form).not.toContainText(localUrl);
  await expect(form.getByRole("img", { name: "Preview 的截圖" })).toBeVisible();
  await form.getByRole("textbox", { name: "留言內容" }).fill("標題要更大");
  await form.getByRole("button", { name: "加入 Review 留言草稿" }).click();
  await expect(form).toBeHidden();
  // 草稿（截圖已上傳成這個 Run 的 blob）列在 Preview 分頁，存在 sessionStorage，換頁不會遺失
  const panelDrafts = page.getByRole("region", { name: "Preview 留言草稿" });
  await expect(panelDrafts).toContainText("標題要更大");
  await expect(panelDrafts.locator("code")).toHaveText("#app");

  // ---- Review 頁：草稿列在「Preview 留言」區塊，退回時一起送出（Server 檢查網址是這個 Run 的 Preview 網址）
  await page.getByRole("link", { name: "Diff review" }).click();
  const drafts = page.getByRole("region", { name: /^Preview 留言（1）/ });
  await expect(drafts).toContainText("標題要更大");
  await expect(drafts.locator("code")).toHaveText("#app");
  await expect(drafts).toContainText(`${shareOrigin}/`);
  await page.getByRole("button", { name: /退回並附上留言/ }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));

  // ---- Agent 的第二回合回報收到的 prompt：文字含 Preview 網址、selector 與截圖編號，截圖以 image 區塊附上
  const agentText = async () =>
    (await events(runId))
      .filter((e) => e.kind === "message_chunk")
      .map((e) => String((e.payload.content as { text?: string } | undefined)?.text ?? ""))
      .join("\n");
  await expect
    .poll(agentText, { timeout: 120_000, message: "Agent 回報收到的 prompt" })
    .toContain(`${shareOrigin}/（#app）（截圖 1）：標題要更大`);
  const reported = await agentText();
  expect(reported).toContain("在 Preview 上的留言：");
  // 截圖：Agent 宣告支援圖片時以 ACP image 區塊送出；Fake Agent 沒有宣告，Runner 改送說明文字（A2 的設計）
  expect(reported).toMatch(/image:image\/png:[A-Za-z0-9+/=]{100,}|\[圖片 [^\]]*image\/png[^\]]*\]/);
  // 第二回合結束，再次進入 Review Gate
  await expect(page.getByTestId("run-status")).toHaveText("等待關卡", { timeout: 60_000 });
  recordProcesses();
});
