// 完整系統 e2e 的 globalSetup：啟動 `e2e:stack` 與 Vite，把 ready 行交給測試；
// 回傳的函式是 teardown：關閉 Vite 與 stack，確認沒有殘留的程序。

import type { FullConfig } from "@playwright/test";
import { systemPorts } from "./ports";
import { descendants, isAlive, STACK_ENV, startStack, startWeb } from "./stack";

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const { serverPort, webPort } = systemPorts();
  const webOrigin = `http://localhost:${webPort}`;
  const stack = await startStack(serverPort, webOrigin);
  let web: Awaited<ReturnType<typeof startWeb>>;
  try {
    web = await startWeb(webPort, serverPort);
  } catch (error) {
    await stack.stop();
    throw error;
  }
  process.env[STACK_ENV] = JSON.stringify(stack.ready);

  return async () => {
    const webProcesses = web.pid === undefined ? [] : [web.pid, ...descendants(web.pid)];
    const processes = [...stack.processes(), ...webProcesses];
    await web.stop();
    const code = await stack.stop();
    if (code !== 0) throw new Error(`e2e:stack 沒有正常結束（${code}）`);
    // 給作業系統一點時間回收程序
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const leftovers = processes.filter(isAlive);
    if (leftovers.length > 0) {
      throw new Error(`完整系統結束後仍有殘留的程序：${leftovers.join(", ")}`);
    }
  };
}
