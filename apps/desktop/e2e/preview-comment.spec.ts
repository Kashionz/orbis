// 在 Preview 上留言（E2 的完成條件，ARCHITECTURE §13）：Electron 主視窗載入 Web UI 的 PreviewPanel
// （以 esbuild 打包 apps/web/src/features/preview/e2e-harness.tsx），在內嵌瀏覽器中選取元素、寫留言、
// 加入草稿（上傳截圖），再以 Review Gate 退回送出。驗證 Server 收到的 previewComments 帶有 selector、
// 網址與截圖（PNG）。
//
// Server 把 previewComments 打包成給 Agent 的 prompt（B2）、Runner 把截圖以圖片送給 Agent（A2 #17）
// 屬於其他軌，端到端的 prompt 驗證在整合階段（91 integration）以 Fake Agent 的劇本檢查。

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";
import { type Desktop, launchDesktop, waitUntil } from "./fixtures/desktop";
import { type FakeServer, startFakeServer } from "./fixtures/fake-server";
import { type DevServer, previewTools, startDevServer } from "./fixtures/preview";

const RUN = "0192f0c4-7a1b-7c3d-8e9f-0a1b2c3d4e5f";
const GATE = "0192f0c4-7a1b-7c3d-8e9f-0a1b2c3d4e70";
const HARNESS = "/preview-harness";

const webDir = resolve(fileURLToPath(new URL("../../web", import.meta.url)));

let server: FakeServer;
let devServer: DevServer;
let desktop: Desktop | undefined;
let harness: { js: string; css: string };

/** 把測試頁連同 React、PreviewPanel 打包成一個 JS 與一個 CSS。 */
async function buildHarness(): Promise<{ js: string; css: string }> {
  const result = await build({
    entryPoints: [join(webDir, "src", "features", "preview", "e2e-harness.tsx")],
    bundle: true,
    write: false,
    format: "esm",
    outdir: "out",
    jsx: "automatic",
    // 測試頁的相依套件（React、TanStack Query）裝在 apps/web
    nodePaths: [join(webDir, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  const text = (ext: string) => result.outputFiles.find((f) => f.path.endsWith(ext))?.text ?? "";
  return { js: text(".js"), css: text(".css") };
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  harness = await buildHarness();
});

test.beforeEach(async () => {
  server = await startFakeServer();
  devServer = await startDevServer(server.url, RUN);
  server.state.files[HARNESS] = {
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html><head><meta charset="utf-8"><title>Preview 留言</title>
<link rel="stylesheet" href="${HARNESS}.css"></head>
<body style="margin:0"><div id="root"></div><script type="module" src="${HARNESS}.js"></script></body></html>`,
  };
  server.state.files[`${HARNESS}.js`] = {
    contentType: "text/javascript; charset=utf-8",
    body: harness.js,
  };
  server.state.files[`${HARNESS}.css`] = {
    contentType: "text/css; charset=utf-8",
    body: harness.css,
  };
});

test.afterEach(async () => {
  await desktop?.close();
  desktop = undefined;
  await devServer.close();
  await server.close();
});

/** 啟動 Desktop、登入，並讓 Run 由這台 Desktop 的 Local Runner 執行（內嵌瀏覽器直接開 localhost）。 */
async function openHarness(): Promise<{ main: Page; d: Desktop }> {
  desktop = await launchDesktop({ config: { serverUrl: server.url } });
  const d = desktop;
  const main = await d.mainWindow();
  await main.click("#login");
  await expect(main.locator("#path")).toHaveText("/");
  const runnerId = await waitUntil(
    () => d.hooks((h) => h.config().runnerId),
    (id) => id !== null,
    "sidecar 回報 Runner ID",
  );
  server.state.previews[RUN] = {
    status: "ready",
    runnerId,
    port: devServer.port,
    localUrl: `${devServer.url}/`,
    shareUrl: null,
    stopped: null,
  };
  await main.goto(`${server.url}${HARNESS}?run=${RUN}&gate=${GATE}`);
  return { main, d };
}

test("在 Preview 上選取元素留言：草稿帶 selector、網址與截圖，Review Gate 退回時送出", async () => {
  const { main, d } = await openHarness();
  const preview = previewTools(d);
  await waitUntil(preview.url, (url) => url === `${devServer.url}/`, "內嵌瀏覽器開啟 localhost");

  // 選取元素
  await main.getByRole("button", { name: "選取元素留言" }).click();
  await preview.waitForOverlay();
  await preview.click('[data-testid="save"]');

  // 留言框：截圖、selector、網址
  const form = main.getByRole("form", { name: "Preview 留言" });
  await expect(form).toBeVisible();
  await expect(form.locator("code")).toHaveText('[data-testid="save"]');
  await expect(form).toContainText(`${devServer.url}/`);
  await expect(form.getByRole("img", { name: "Preview 的截圖" })).toBeVisible();
  // 選取時攔下點擊，頁面沒有收到；截圖後移除外框
  expect(await preview.run("window.clicked ?? 0")).toBe(0);
  expect(await preview.overlayPresent()).toBe(false);

  await form.getByRole("textbox", { name: "留言內容" }).fill("儲存按鈕的顏色太淡");
  await form.getByRole("button", { name: "加入 Review 留言草稿" }).click();
  const drafts = main.getByRole("region", { name: "Preview 留言草稿" });
  await expect(drafts).toContainText("儲存按鈕的顏色太淡");
  await expect(drafts.locator("code")).toHaveText('[data-testid="save"]');
  await expect(form).toBeHidden();

  // Review Gate 退回：草稿放進 previewComments
  await main.getByRole("button", { name: "退回" }).click();
  await expect(main.locator("#result")).toHaveText("HTTP 200");
  expect(server.state.gateDecisions).toHaveLength(1);
  const decision = server.state.gateDecisions[0];
  expect(decision?.gateId).toBe(GATE);
  const body = decision?.body as {
    action: string;
    previewComments: {
      body: string;
      url: string;
      selector: string | null;
      screenshotBlobId: string | null;
    }[];
  };
  expect(body.action).toBe("reject");
  expect(body.previewComments).toEqual([
    {
      body: "儲存按鈕的顏色太淡",
      url: `${devServer.url}/`,
      selector: '[data-testid="save"]',
      screenshotBlobId: expect.any(String),
    },
  ]);
  const screenshot = server.state.screenshots.get(body.previewComments[0]?.screenshotBlobId ?? "");
  expect(screenshot?.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(screenshot?.byteLength).toBeGreaterThan(1000);
  // 送出後清掉草稿
  await expect(drafts).toBeHidden();
});

test("取消選取或取消留言時不產生草稿", async () => {
  const { main, d } = await openHarness();
  const preview = previewTools(d);
  await waitUntil(preview.url, (url) => url === `${devServer.url}/`, "內嵌瀏覽器開啟 localhost");

  await main.getByRole("button", { name: "選取元素留言" }).click();
  await preview.waitForOverlay();
  await preview.pressEscape();
  await expect(main.getByRole("button", { name: "選取元素留言" })).toBeEnabled();
  await expect(main.getByRole("form", { name: "Preview 留言" })).toBeHidden();

  await main.getByRole("button", { name: "選取元素留言" }).click();
  await preview.waitForOverlay();
  await preview.click("li.target");
  const form = main.getByRole("form", { name: "Preview 留言" });
  await expect(form.locator("code")).toHaveText("li:nth-of-type(2)");
  await form.getByRole("button", { name: "取消" }).click();
  await expect(form).toBeHidden();
  await expect(main.getByRole("region", { name: "Preview 留言草稿" })).toBeHidden();
  expect(server.state.screenshots.size).toBe(0);
});
