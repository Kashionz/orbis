// Preview 的 e2e 共用：代替 dev server 的頁面，以及在 main 程序中操作 Preview 內嵌瀏覽器的 helper。

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ElectronApplication } from "@playwright/test";
import { OVERLAY_ID } from "../../src/main/preview/picker";
import { previewAuthorizePath } from "../../src/main/preview/target";
import { type Desktop, waitUntil } from "./desktop";
import { PREVIEW_CALLBACK_PATH } from "./fake-server";

const PREVIEW_COOKIE = "preview_session";

export interface DevServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * 代替 dev server 的頁面。以 `<run-id>.preview.localhost` 開啟時扮演 Preview 網址：沒有 preview cookie
 * 就轉到 Web UI 的 authorize 換票，callback 設定 cookie 後導回原本的路徑。
 */
export async function startDevServer(webUrl: string, runId: string): Promise<DevServer> {
  const http: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const shared = (req.headers.host ?? "").startsWith(`${runId}.`);
    if (shared && url.pathname === PREVIEW_CALLBACK_PATH) {
      res.writeHead(302, {
        location: url.searchParams.get("return") ?? "/",
        "set-cookie": `${PREVIEW_COOKIE}=ok; Path=/; HttpOnly; SameSite=Lax`,
      });
      return res.end();
    }
    if (shared && !(req.headers.cookie ?? "").includes(`${PREVIEW_COOKIE}=ok`)) {
      const authorize = new URL(previewAuthorizePath(runId), webUrl);
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

/** 在 main 程序中操作 Preview 的內嵌瀏覽器。 */
export function previewTools(desktop: Desktop) {
  const app: ElectronApplication = desktop.app;

  async function webContentsId(): Promise<number> {
    return (await waitUntil(
      () => desktop.hooks((h) => h.previewWebContentsId()),
      (v) => v !== null,
      "Preview 的 webContents",
    )) as number;
  }

  /** 在 Preview 的頁面中執行。 */
  async function run<T>(script: string): Promise<T> {
    const id = await webContentsId();
    return app.evaluate(
      ({ webContents }, [wcId, code]) =>
        webContents.fromId(wcId as number)?.executeJavaScript(code),
      [id, script] as const,
    ) as Promise<T>;
  }

  return {
    webContentsId,
    run,
    url: () => run<string>("location.href"),

    /** 對 Preview 送出真正的滑鼠事件（移到元素中央後點擊）。 */
    async click(selector: string): Promise<void> {
      const rect = await run<{ x: number; y: number }>(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
      );
      const id = await webContentsId();
      await app.evaluate(
        ({ webContents }, [wcId, x, y]) => {
          const contents = webContents.fromId(wcId as number);
          if (!contents) throw new Error("沒有 Preview 的 webContents");
          const at = { x: x as number, y: y as number };
          contents.sendInputEvent({ type: "mouseMove", ...at });
          contents.sendInputEvent({ type: "mouseDown", ...at, button: "left", clickCount: 1 });
          contents.sendInputEvent({ type: "mouseUp", ...at, button: "left", clickCount: 1 });
        },
        [id, rect.x, rect.y] as const,
      );
    },

    async pressEscape(): Promise<void> {
      const id = await webContentsId();
      await app.evaluate(({ webContents }, wcId) => {
        webContents.fromId(wcId as number)?.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      }, id);
    },

    /** 等選取模式的 overlay 裝好。 */
    async waitForOverlay(): Promise<void> {
      await waitUntil(
        () => run<boolean>(`!!document.getElementById(${JSON.stringify(OVERLAY_ID)})`),
        (v) => v,
        "選取的 overlay",
      );
    },

    overlayPresent: () => run<boolean>(`!!document.getElementById(${JSON.stringify(OVERLAY_ID)})`),
  };
}
