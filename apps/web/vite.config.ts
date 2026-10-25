/// <reference types="vitest/config" />

import { envVar, NAMES } from "@orbis/api-contract/names";
import react from "@vitejs/plugin-react";
import { msw } from "msw/vite";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";

/** Vite dev server 的 port（已核准的設計決定 11）。 */
const DEV_PORT = 5173;
const DEFAULT_SERVER_PORT = 4000;

/** Server 的 port，預設 4000，可用 `<前綴>SERVER_PORT` 覆寫。 */
function serverPort(): number {
  const name = envVar("SERVER_PORT");
  const raw = process.env[name];
  if (raw === undefined || raw === "") return DEFAULT_SERVER_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${name} 必須是 1–65535 的整數，目前是 ${JSON.stringify(raw)}`);
  }
  return port;
}

/** 把 index.html 中的 `%PRODUCT_NAME%`、`%PRODUCT_SLUG%` 換成名稱常數，避免在 HTML 中寫死。 */
function productNameInHtml(): Plugin {
  return {
    name: "product-name-in-html",
    transformIndexHtml: (html) =>
      html
        .replaceAll("%PRODUCT_NAME%", NAMES.productName)
        .replaceAll("%PRODUCT_SLUG%", NAMES.productSlug),
  };
}

const apiProxy: Record<string, ProxyOptions> = {
  "/api": { target: `http://localhost:${serverPort()}`, ws: true },
  // 邀請連結由 Server 處理（PAGE_ROUTES）；失敗頁 `/invites/error` 是 Web 的頁面，不轉送
  "^/invites/(?!error(?:$|[/?]))": { target: `http://localhost:${serverPort()}` },
  "/preview-invites/": { target: `http://localhost:${serverPort()}` },
};

/** `vite --mode mock`：以 MSW 假後端取代 Server（src/mocks），開發與元件層級的 e2e 使用。 */
export const MOCK_MODE = "mock";

export default defineConfig(({ mode }) => ({
  // mock 模式只需要 MSW 提供 worker 腳本；handler 由 src/mocks/browser.ts 自己設定
  plugins: [
    react(),
    productNameInHtml(),
    ...(mode === MOCK_MODE ? [msw({ mode: "worker-only" })] : []),
  ],
  server: { port: DEV_PORT, strictPort: true, proxy: mode === MOCK_MODE ? undefined : apiProxy },
  preview: { proxy: apiProxy },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
