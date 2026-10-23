// Preview 的內嵌瀏覽器與元素選取（ARCHITECTURE §13）：Web UI 經由 bridge 開啟 Run 的 Preview，
// Desktop 依 Run 決定開 localhost（自己的 Local Runner）或 Preview 網址（別人的 Run），
// 在 Preview 上選取元素時回傳 selector、URL 與截圖。

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import {
  DESKTOP_BRIDGE_KEY,
  type DesktopActionResult,
  type PreviewBounds,
  type PreviewShowResult,
} from "../src/bridge";
import { OVERLAY_ID } from "../src/main/preview/picker";
import { previewAuthorizePath } from "../src/main/preview/target";
import { type Desktop, launchDesktop, waitUntil } from "./fixtures/desktop";
import { type FakeServer, PREVIEW_CALLBACK_PATH, startFakeServer } from "./fixtures/fake-server";

const RUN = "0192f0c4-7a1b-7c3d-8e9f-0a1b2c3d4e5f";
const BOUNDS: PreviewBounds = { x: 0, y: 80, width: 900, height: 600 };
const PREVIEW_COOKIE = "preview_session";

let server: FakeServer;
let devServer: { url: string; port: number; close(): Promise<void> };
let desktop: Desktop | undefined;

/**
 * 代替 dev server 的頁面。以 `<run-id>.preview.localhost` 開啟時扮演 Preview 網址：沒有 preview cookie
 * 就轉到 Web UI 的 authorize 換票，callback 設定 cookie 後導回原本的路徑。
 */
async function startDevServer(webUrl: string): Promise<typeof devServer> {
  const http: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const shared = (req.headers.host ?? "").startsWith(`${RUN}.`);
    if (shared && url.pathname === PREVIEW_CALLBACK_PATH) {
      res.writeHead(302, {
        location: url.searchParams.get("return") ?? "/",
        "set-cookie": `${PREVIEW_COOKIE}=ok; Path=/; HttpOnly; SameSite=Lax`,
      });
      return res.end();
    }
    if (shared && !(req.headers.cookie ?? "").includes(`${PREVIEW_COOKIE}=ok`)) {
      const authorize = new URL(previewAuthorizePath(RUN), webUrl);
      authorize.searchParams.set("return", url.pathname);
      res.writeHead(302, { location: authorize.href });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>預覽 ${url.pathname}</title>
<style>body{margin:0;font:16px sans-serif} li{padding:12px} button{margin:12px;padding:12px 24px}</style>
</head><body>
<h1 id="title">${url.pathname}</h1>
<ul><li>第一項</li><li class="target">第二項</li><li>第三項</li></ul>
<button data-testid="save" onclick="window.clicked = (window.clicked || 0) + 1">儲存</button>
<a id="external" href="https://example.com/">外部連結</a>
</body></html>`);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    port,
    close: async () => {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

test.beforeEach(async () => {
  server = await startFakeServer();
  devServer = await startDevServer(server.url);
});

test.afterEach(async () => {
  await desktop?.close();
  desktop = undefined;
  await devServer.close();
  await server.close();
});

/** 啟動 Desktop 並登入；回傳主視窗與 sidecar 回報的 Runner ID。 */
async function signedIn(): Promise<{ main: Page; runnerId: string }> {
  desktop = await launchDesktop({ config: { serverUrl: server.url } });
  const main = await desktop.mainWindow();
  await main.click("#login");
  await expect(main.locator("#path")).toHaveText("/");
  const d = desktop;
  const runnerId = await waitUntil(
    () => d.hooks((h) => h.config().runnerId),
    (id) => id !== null,
    "sidecar 回報 Runner ID",
  );
  return { main, runnerId: runnerId as string };
}

function callBridge<T>(main: Page, method: string, ...args: unknown[]): Promise<T> {
  return main.evaluate(
    ([key, name, params]) => {
      const bridge = (window as unknown as Record<string, Record<string, Record<string, unknown>>>)[
        key
      ];
      const fn = bridge?.preview?.[name] as (...a: unknown[]) => Promise<unknown>;
      return fn(...params);
    },
    [DESKTOP_BRIDGE_KEY, method, args] as const,
  ) as Promise<T>;
}

/** 在 main 程序中對 Preview 的 webContents 執行。 */
async function inPreview<T>(app: ElectronApplication, script: string): Promise<T> {
  const id = await waitUntil(
    () => desktop?.hooks((h) => h.previewWebContentsId()) ?? Promise.resolve(null),
    (v) => v !== null,
    "Preview 的 webContents",
  );
  return app.evaluate(
    ({ webContents }, [wcId, code]) => webContents.fromId(wcId as number)?.executeJavaScript(code),
    [id, script] as const,
  ) as Promise<T>;
}

async function previewUrl(app: ElectronApplication): Promise<string> {
  return inPreview<string>(app, "location.href");
}

/** 對 Preview 送出真正的滑鼠事件（移到元素中央後點擊）。 */
async function clickInPreview(app: ElectronApplication, selector: string): Promise<void> {
  const rect = await inPreview<{ x: number; y: number }>(
    app,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
  );
  const id = await desktop?.hooks((h) => h.previewWebContentsId());
  await app.evaluate(
    ({ webContents }, [wcId, x, y]) => {
      const contents = webContents.fromId(wcId as number);
      if (!contents) throw new Error("沒有 Preview 的 webContents");
      contents.sendInputEvent({ type: "mouseMove", x: x as number, y: y as number });
      contents.sendInputEvent({
        type: "mouseDown",
        x: x as number,
        y: y as number,
        button: "left",
        clickCount: 1,
      });
      contents.sendInputEvent({
        type: "mouseUp",
        x: x as number,
        y: y as number,
        button: "left",
        clickCount: 1,
      });
    },
    [id, rect.x, rect.y] as const,
  );
}

/** 開始選取（不等結果），等 overlay 裝好。 */
async function startPicking(main: Page, app: ElectronApplication): Promise<void> {
  await main.evaluate((key) => {
    const bridge = (window as unknown as Record<string, { preview: { pickElement(): unknown } }>)[
      key
    ];
    (window as unknown as Record<string, unknown>).__pick = Promise.resolve(
      bridge?.preview.pickElement(),
    ).then((pick) => {
      if (!pick) return null;
      const { screenshot, ...rest } = pick as { screenshot: Uint8Array };
      // 截圖只回傳開頭的 8 bytes（PNG 簽章）與大小
      return { ...rest, png: Array.from(screenshot.slice(0, 8)), size: screenshot.length };
    });
  }, DESKTOP_BRIDGE_KEY);
  await waitUntil(
    () => inPreview<boolean>(app, `!!document.getElementById(${JSON.stringify(OVERLAY_ID)})`),
    (v) => v,
    "選取的 overlay",
  );
}

interface PickResult {
  selector: string;
  url: string;
  tagName: string;
  text: string;
  rect: PreviewBounds;
  png: number[];
  size: number;
}

function pickResult(main: Page): Promise<PickResult | null> {
  return main.evaluate(() => (window as unknown as { __pick: Promise<PickResult | null> }).__pick);
}

test("自己的 Local Runner 跑的 Run 直接開 localhost，選取元素時回傳 selector、URL 與截圖", async () => {
  const { main, runnerId } = await signedIn();
  if (!desktop) throw new Error("Desktop 尚未啟動");
  const app = desktop.app;
  server.state.previews[RUN] = {
    status: "ready",
    runnerId,
    port: devServer.port,
    localUrl: `${devServer.url}/`,
    shareUrl: null,
  };

  const shown = await callBridge<PreviewShowResult>(main, "show", RUN, BOUNDS);
  expect(shown).toEqual({ ok: true, mode: "local", url: `${devServer.url}/` });
  expect(await previewUrl(app)).toBe(`${devServer.url}/`);
  // Preview 是 Agent 寫的程式：沒有 bridge、沒有 Node，啟用 sandbox
  expect(
    await inPreview(
      app,
      `[typeof window[${JSON.stringify(DESKTOP_BRIDGE_KEY)}], typeof require, typeof process]`,
    ),
  ).toEqual(["undefined", "undefined", "undefined"]);
  const id = await desktop.hooks((h) => h.previewWebContentsId());
  const prefs = await app.evaluate(({ webContents }, wcId) => {
    // getLastWebPreferences 沒有寫在型別定義中，但能讀出 Chromium 實際套用的設定
    const contents = webContents.fromId(wcId as number) as unknown as {
      getLastWebPreferences(): Electron.WebPreferences;
    };
    const p = contents.getLastWebPreferences();
    return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, preload: p.preload };
  }, id);
  expect(prefs).toEqual({ sandbox: true, contextIsolation: true, preload: undefined });

  await startPicking(main, app);
  await clickInPreview(app, "li.target");
  const pick = await pickResult(main);
  expect(pick).toMatchObject({
    selector: "li:nth-of-type(2)",
    url: `${devServer.url}/`,
    tagName: "li",
    text: "第二項",
  });
  expect(pick?.png).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(pick?.size).toBeGreaterThan(1000);
  expect(pick?.rect.width).toBeGreaterThan(0);
  // 截圖後移除外框
  expect(await inPreview(app, `!!document.getElementById(${JSON.stringify(OVERLAY_ID)})`)).toBe(
    false,
  );

  // data-testid 優先；選取時頁面不會收到點擊
  await startPicking(main, app);
  await clickInPreview(app, "button");
  expect((await pickResult(main))?.selector).toBe('[data-testid="save"]');
  expect(await inPreview(app, "window.clicked ?? 0")).toBe(0);

  // Esc 取消
  await startPicking(main, app);
  await app.evaluate(({ webContents }, wcId) => {
    webContents.fromId(wcId as number)?.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  }, id);
  expect(await pickResult(main)).toBeNull();

  // 選取模式結束後，點擊正常送給頁面
  await clickInPreview(app, "button");
  await waitUntil(
    () => inPreview<number>(app, "window.clicked ?? 0"),
    (n) => n === 1,
    "頁面收到點擊",
  );
});

test("別人的 Run 開 Preview 網址，經過 authorize 換票後留在內嵌瀏覽器", async () => {
  const { main } = await signedIn();
  if (!desktop) throw new Error("Desktop 尚未啟動");
  const app = desktop.app;
  const shareUrl = `http://${RUN}.preview.localhost:${devServer.port}/`;
  server.state.previews[RUN] = {
    status: "ready",
    runnerId: "someone-else",
    port: 41000,
    localUrl: "http://localhost:41000/",
    shareUrl,
  };

  const shown = await callBridge<PreviewShowResult>(main, "show", RUN, BOUNDS);
  expect(shown).toEqual({ ok: true, mode: "share", url: shareUrl });
  await waitUntil(
    () => previewUrl(app),
    (url) => url === shareUrl,
    "換票後回到 Preview 網址",
  );
  expect(server.state.previewAuthorizations).toEqual([RUN]);
  expect(await inPreview(app, "document.getElementById('title').textContent")).toBe("/");

  // 網址列：同一個 Preview 的網址留在內嵌瀏覽器，其他網址交給外部瀏覽器
  expect(await callBridge<DesktopActionResult>(main, "navigate", `${shareUrl}other`)).toEqual({
    ok: true,
  });
  await waitUntil(
    () => previewUrl(app),
    (url) => url === `${shareUrl}other`,
    "前往 /other",
  );
  expect(await callBridge<DesktopActionResult>(main, "navigate", "https://example.com/x")).toEqual({
    ok: true,
  });
  expect(await callBridge<DesktopActionResult>(main, "navigate", "file:///etc/passwd")).toEqual({
    ok: false,
    message: "不支援這個網址",
  });
  // 頁面中的外部連結也交給外部瀏覽器
  await inPreview(app, "document.getElementById('external').click()");
  await waitUntil(
    () => desktop?.hooks((h) => h.externalUrls) ?? Promise.resolve([]),
    (urls) => urls.includes("https://example.com/"),
    "外部連結交給外部瀏覽器",
  );
  // 頁面接著連續叫出外部瀏覽器：間隔內的一律丟棄
  await inPreview(
    app,
    "for (let i = 0; i < 5; i++) window.open('https://example.com/spam' + i); location.href = 'https://example.com/spam'",
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await desktop.hooks((h) => h.externalUrls)).toEqual([
    "https://example.com/x",
    "https://example.com/",
  ]);
  expect(await previewUrl(app)).toBe(`${shareUrl}other`);
});

test("Preview 還沒就緒或沒有 Preview 網址時回傳原因", async () => {
  const { main } = await signedIn();
  server.state.previews[RUN] = {
    status: "starting",
    runnerId: null,
    port: null,
    localUrl: null,
    shareUrl: null,
  };
  expect(await callBridge<PreviewShowResult>(main, "show", RUN, BOUNDS)).toEqual({
    ok: false,
    message: "Preview 啟動中…",
  });
  server.state.previews[RUN] = {
    status: "ready",
    runnerId: "someone-else",
    port: 41000,
    localUrl: "http://localhost:41000/",
    shareUrl: null,
  };
  expect(await callBridge<PreviewShowResult>(main, "show", RUN, BOUNDS)).toEqual({
    ok: false,
    message: "Server 沒有設定 Preview 網域，只能在執行這個 Run 的電腦上開啟 Preview",
  });
  expect(await callBridge<PreviewShowResult>(main, "show", "../x", BOUNDS)).toEqual({
    ok: false,
    message: "參數不正確",
  });
});
