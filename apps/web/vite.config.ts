/// <reference types="vitest/config" />

import { envVar, NAMES } from "@orbis/api-contract/names";
import react from "@vitejs/plugin-react";
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

/** 把 index.html 中的 `%PRODUCT_NAME%` 換成產品名稱，避免在 HTML 中寫死。 */
function productNameInHtml(): Plugin {
  return {
    name: "product-name-in-html",
    transformIndexHtml: (html) => html.replaceAll("%PRODUCT_NAME%", NAMES.productName),
  };
}

const apiProxy: Record<string, ProxyOptions> = {
  "/api": { target: `http://localhost:${serverPort()}`, ws: true },
};

export default defineConfig({
  plugins: [react(), productNameInHtml()],
  server: { port: DEV_PORT, strictPort: true, proxy: apiProxy },
  preview: { proxy: apiProxy },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
