// 在瀏覽器啟動 MSW 假後端（只在 `vite --mode mock` 時載入）。

import { setupWorker } from "msw/browser";
import { MockBackend } from "./backend";
import { createHandlers } from "./handlers";

export async function startMockBackend(): Promise<void> {
  const backend = new MockBackend();
  const worker = setupWorker(...createHandlers(backend));
  await worker.start({ onUnhandledFrame: "bypass", quiet: true });
  backend.start();
}
