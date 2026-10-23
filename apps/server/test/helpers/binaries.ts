// 測試用的 Runner 與 Fake Agent 執行檔。
//
// 每個測試檔都用「完全相同」的 cargo build 指令：套件組合不同時 feature unification 的結果不同，
// cargo 會重新連結執行檔；Windows 上另一個測試檔正在執行舊的 orbis-runner.exe 時就無法覆蓋
// （Access is denied）。指令相同時，後到的 build 只會等 cargo 的鎖，然後發現已是最新的。

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NAMES } from "@orbis/api-contract";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

/** 編譯 Runner 與 Fake Agent（已是最新時不做任何事）。 */
export function buildRunnerBinaries(): void {
  execFileSync(
    "cargo",
    [
      "build",
      "--quiet",
      "-p",
      `${NAMES.productSlug}-runner`,
      "-p",
      `${NAMES.productSlug}-fake-agent`,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
}
