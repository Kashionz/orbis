// 檢查 schema 與 commit 的 migration 是否一致（CI 使用）。
//
// 把現有的 migration 複製到暫存目錄，對暫存目錄執行 `drizzle-kit generate`。
// 如果產生了新的檔案，代表 schema 有變更但沒有產生 migration，以非 0 結束。

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = join(serverRoot, "src", "db", "migrations");
// drizzle-kit 沒有在 exports 公開 bin.cjs，從主進入點所在的目錄找。
const drizzleKitBin = join(
  dirname(createRequire(import.meta.url).resolve("drizzle-kit")),
  "bin.cjs",
);
// drizzle-kit 一律把 out 接在 cwd 後面，Windows 的絕對路徑會被接壞，所以暫存目錄放在
// server 目錄內（node_modules 已被 git 忽略），再以相對路徑傳入。
const tempParent = join(serverRoot, "node_modules", ".cache");

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

mkdirSync(tempParent, { recursive: true });
const tempDir = mkdtempSync(join(tempParent, "db-check-"));
try {
  cpSync(migrationsDir, tempDir, { recursive: true });
  const before = new Set(listFiles(tempDir));

  // 直接用目前的 node 執行 drizzle-kit 的 JS 進入點，不經過 shell，避免 Windows 的 .cmd 與引號問題。
  const result = spawnSync(process.execPath, [drizzleKitBin, "generate"], {
    cwd: serverRoot,
    env: { ...process.env, DRIZZLE_MIGRATIONS_OUT: relative(serverRoot, tempDir) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  // drizzle-kit 部分錯誤仍以 0 結束，所以同時檢查它有沒有印出「沒有變更」。
  if (result.status !== 0 || !output.includes("No schema changes")) {
    const added = result.status === 0 ? listFiles(tempDir).filter((f) => !before.has(f)) : [];
    if (added.length > 0) {
      console.error("db:check：schema 與 migration 不一致，會產生以下新檔案：");
      for (const file of added) console.error(`  ${file}`);
      console.error("請執行 `pnpm --filter @orbis/server db:generate` 並 commit 產生的 migration。");
    } else {
      console.error(`db:check：drizzle-kit generate 失敗（exit ${result.status ?? result.signal}）`);
    }
    process.exit(1);
  }
  console.log("db:check: OK");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
