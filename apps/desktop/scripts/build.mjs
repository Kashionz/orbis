#!/usr/bin/env node
// 以 esbuild 打包 Desktop：main 是 ESM；preload 在 sandbox 中執行，只能是 CommonJS；設定頁是瀏覽器端的 IIFE。
// 加上 `--with-runner` 時先 `cargo build` Runner（開發模式與 e2e 使用 target/debug 的產物）。

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NAMES } from "@orbis/api-contract/names";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = fileURLToPath(new URL("../dist", import.meta.url));

if (process.argv.includes("--with-runner")) {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  // 參數以陣列傳給 spawn，不經過 shell
  const cargo = spawnSync("cargo", ["build", "-p", `${NAMES.productSlug}-runner`], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (cargo.status !== 0) process.exit(cargo.status ?? 1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(`${dist}/renderer`, { recursive: true });

const common = {
  absWorkingDir: root,
  bundle: true,
  sourcemap: "linked",
  logLevel: "warning",
  external: ["electron"],
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/main/index.ts"],
    outfile: "dist/main.mjs",
    platform: "node",
    format: "esm",
    target: "node22",
    // 打包進來的 CommonJS 相依套件可能會 require() Node 內建模組
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  }),
  ...[
    ["src/preload/bridge.ts", "dist/preload.cjs"],
    ["src/preload/settings.ts", "dist/settings-preload.cjs"],
  ].map(([entry, outfile]) =>
    build({
      ...common,
      entryPoints: [entry],
      outfile,
      platform: "node",
      format: "cjs",
      target: "node22",
    }),
  ),
  build({
    ...common,
    entryPoints: ["src/renderer/settings.ts"],
    outfile: "dist/renderer/settings.js",
    platform: "browser",
    format: "iife",
    target: "chrome130",
  }),
]);

for (const file of ["settings.html", "settings.css"]) {
  copyFileSync(`${root}/src/renderer/${file}`, `${dist}/renderer/${file}`);
}
