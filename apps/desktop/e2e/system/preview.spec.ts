// Preview 的轉送（E2 的完成條件，ARCHITECTURE §13）：真實 Server + Postgres + Runner + Fake Agent，
// Repo 中是一個最小的 Vite app。
//
// 1. `e2e:stack` 自己啟動 Runner，Server 設定 Preview 網域 `preview.localhost:<port>`。
// 2. 把 Vite app 與 `[preview]` 設定推到 stack 的 bare repo，建立 Task 並派工給 Local Runner。
// 3. 核准設定檔的信任與 Agent 的權限請求，等到 `preview_ready`。
// 4. 以 Preview 網址（Host header）經由 Server → Runner 通道存取 dev server：
//    - 未登入的請求被拒絕（頁面導覽轉到 authorize，其他請求 401，WebSocket 401）。
//    - 換票後 HTTP 正常、HMR 的 WebSocket 在修改檔案後收到更新、20 MiB 的檔案 SHA-256 一致。
// 結束時關閉 stack，確認自己啟動的程序樹都已結束。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { API_ROUTES, apiPath } from "@orbis/api-contract";
import { envVar, NAMES } from "@orbis/api-contract/names";
import type { ReadyLine } from "@orbis/server/e2e";
import { expect, test } from "@playwright/test";
import { WebSocket } from "ws";
import { waitUntil } from "../fixtures/desktop";
import { freePort, ProcessLedger, type StartedStack, startStack } from "./stack";

test.describe.configure({ mode: "serial" });

const BIG_SIZE = 20 * 1024 * 1024;
const BIG_FILE = "big.bin";

let stack: StartedStack | undefined;
let ready: ReadyLine;
let serverPort: number;
let previewHost: string;
let runId: string;
let worktreePath: string;
let previewCookie: string;
const ledger = new ProcessLedger();

function sessionCookie(): string {
  return `${ready.sessionCookie.name}=${ready.sessionCookie.value}`;
}

/** 以 session 呼叫 stack 的 Server API。 */
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ready.serverUrl}${path}`, {
    method,
    headers: {
      cookie: sessionCookie(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} 回應 ${res.status}：${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** 以 Preview 網址的 Host 送出請求（Node 的 fetch 不能改 Host）。 */
function preview(path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: serverPort, path, headers: { host: previewHost, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 連 Preview 網址的 WebSocket；回傳開好的連線，或被拒絕時的狀態碼。 */
function previewSocket(path: string, cookie?: string): Promise<WebSocket | number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}${path}`, "vite-hmr", {
      headers: {
        host: previewHost,
        origin: `http://${previewHost}`,
        ...(cookie && { cookie }),
      },
    });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", reject);
  });
}

/** 推到 stack 的 bare repo：一個最小的 Vite app，`[preview]` 以 node 啟動 Vite。 */
function pushViteApp(): void {
  const vite = pathToFileURL(createRequire(import.meta.url).resolve("vite")).href;
  const work = mkdtempSync(join(tmpdir(), "preview-e2e-repo-"));
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
        '<!doctype html><html><body><h1 id="app">preview</h1><script type="module" src="/main.js"></script></body></html>\n',
      "main.js": 'document.getElementById("app").textContent = "hello from vite";\n',
      // 用 node 啟動 Vite：cmd、sh 展開環境變數的語法不同，在 node 中讀就不必分平台
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

interface RunEventRow {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
}

/** Run 的 Event（API 的 RunEvent，內容在 `event` 中）。 */
async function events(): Promise<RunEventRow[]> {
  const list = await api<{ seq: number; event: Record<string, unknown> }[]>(
    "GET",
    apiPath(API_ROUTES.runEvents, { runId }),
  );
  return list.map((e) => ({ seq: e.seq, kind: String(e.event.kind), payload: e.event }));
}

test.beforeAll(async () => {
  test.setTimeout(600_000);
  serverPort = await freePort();
  const webPort = await freePort();
  stack = await startStack({
    serverPort,
    webOrigin: `http://localhost:${webPort}`,
    env: { [envVar("PREVIEW_DOMAIN")]: `preview.localhost:${serverPort}` },
  });
  ready = stack.ready;
  expect(ready.runnerId).not.toBeNull();
  ledger.record(stack.pid);
  pushViteApp();
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  ledger.record(stack?.pid);
  const code = await stack?.stop();
  expect(code).not.toBe("timeout");
  await expect.poll(() => ledger.alive(), { timeout: 30_000 }).toEqual([]);
});

test("派工後 Runner 啟動 Vite，preview_ready 回報 port", async () => {
  test.setTimeout(240_000);
  const task = await api<{ id: string }>(
    "POST",
    apiPath(API_ROUTES.projectTasks, { projectId: ready.projectId }),
    { repoId: ready.repoId, title: "Preview 的轉送", description: "以 Vite app 驗證 Preview" },
  );
  await api("POST", apiPath(API_ROUTES.taskAcceptanceCriteria, { taskId: task.id }), {
    kind: "manual",
    description: "Preview 可以開啟",
  });
  await api("POST", apiPath(API_ROUTES.taskTransition, { taskId: task.id }), { status: "ready" });
  const run = await api<{ id: string }>("POST", apiPath(API_ROUTES.taskRuns, { taskId: task.id }), {
    agent: "claude-code",
    runnerKind: "local",
    permissionPolicy: "manual",
  });
  runId = run.id;
  previewHost = `${runId}.preview.localhost:${serverPort}`;

  // 核准設定檔的信任（Preview 指令）與 Agent 的寫檔權限，直到 Preview 就緒
  const answered = new Set<string>();
  const readyEvent = await waitUntil(
    async () => {
      const list = await events();
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
      ledger.record(stack?.pid);
      return list.find((e) => e.kind === "preview_ready") ?? null;
    },
    (event) => event !== null,
    "preview_ready",
    180_000,
  );
  expect(readyEvent?.payload.url).toMatch(/^http:\/\/localhost:\d+\/$/);
  const worktree = (await events()).find((e) => e.kind === "worktree_ready");
  worktreePath = worktree?.payload.worktree_path as string;
  expect(worktreePath).toBeTruthy();
});

test("未登入的請求被拒絕", async () => {
  const navigation = await preview("/", { "sec-fetch-mode": "navigate", accept: "text/html" });
  expect(navigation.status).toBe(302);
  expect(navigation.headers.location).toContain(`/api/preview/${runId}/authorize`);
  expect((await preview("/main.js")).status).toBe(401);
  expect(await previewSocket("/")).toBe(401);
});

test("換票後經由 Runner 通道存取 Vite：HTTP、HMR 的 WebSocket、20 MiB 的檔案", async () => {
  test.setTimeout(180_000);
  // 換票：Web UI 的 authorize（帶 session）→ Preview 網址的 callback（設定 preview cookie）
  const authorize = await fetch(`${ready.serverUrl}/api/preview/${runId}/authorize?return=%2F`, {
    headers: { cookie: sessionCookie() },
    redirect: "manual",
  });
  expect(authorize.status).toBe(302);
  const callback = new URL(authorize.headers.get("location") ?? "");
  expect(callback.host).toBe(previewHost);
  const redeemed = await preview(`${callback.pathname}${callback.search}`);
  expect(redeemed.status).toBe(302);
  previewCookie = String(redeemed.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
  expect(previewCookie).toContain("=");

  // HTTP：index.html 與經過 Vite 轉換的 module
  const page = await preview("/", { cookie: previewCookie });
  expect(page.status).toBe(200);
  expect(page.body.toString()).toContain('<h1 id="app">preview</h1>');
  expect(page.body.toString()).toContain("/@vite/client");
  const main = await preview("/main.js", { cookie: previewCookie });
  expect(main.status).toBe(200);
  expect(main.body.toString()).toContain("hello from vite");

  // HMR：以 /@vite/client 中的 token 連 WebSocket，修改檔案後收到更新
  const client = (await preview("/@vite/client", { cookie: previewCookie })).body.toString();
  const token = /const wsToken = "([^"]+)"/.exec(client)?.[1];
  expect(token).toBeTruthy();
  const socket = await previewSocket(`/?token=${token}`, previewCookie);
  if (typeof socket === "number") throw new Error(`HMR 的 WebSocket 被拒絕：${socket}`);
  const messages: { type: string }[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as { type: string }));
  await expect.poll(() => messages.map((m) => m.type)).toContain("connected");
  writeFileSync(
    join(worktreePath, "main.js"),
    'document.getElementById("app").textContent = "changed by hmr test";\n',
  );
  await expect
    .poll(() => messages.map((m) => m.type), { timeout: 30_000 })
    .toEqual(expect.arrayContaining([expect.stringMatching(/^(update|full-reload)$/)]));
  socket.close();

  // 大檔案：放進 Vite 的 public 目錄，經由通道下載後 SHA-256 一致
  const big = Buffer.alloc(BIG_SIZE);
  for (let i = 0; i < BIG_SIZE; i++) big[i] = (i * 31 + 7) % 251;
  mkdirSync(join(worktreePath, "public"), { recursive: true });
  writeFileSync(join(worktreePath, "public", BIG_FILE), big);
  const download = await preview(`/${BIG_FILE}`, { cookie: previewCookie });
  expect(download.status).toBe(200);
  expect(download.body.byteLength).toBe(BIG_SIZE);
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  expect(sha(download.body)).toBe(sha(big));
});
