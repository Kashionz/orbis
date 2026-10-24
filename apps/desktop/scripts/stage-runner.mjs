#!/usr/bin/env node
// 把 Runner 執行檔放到 electron-builder 的 extraResources 來源目錄 build/runner/<os>-<arch>/
// （electron-builder.ts 以 ${os}-${arch} 選目錄，打包到 resources/bin/）。
//
// 用法：node scripts/stage-runner.mjs [--arch x64|arm64] [--target <Rust target triple>] [--skip-build]
// - 不指定 --target 時用 host 的 toolchain 建置（cargo build --release）。
// - CI 的 macOS 在 arm64 的 runner 上交叉編譯 x64 時指定 --target x86_64-apple-darwin --arch x64。
// - --skip-build 只複製已經建好的執行檔。

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAMES } from "@orbis/api-contract/names";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** electron-builder 的 ${os} 巨集。 */
const OS_MACRO = { win32: "win", darwin: "mac", linux: "linux" };

function parseArgs(argv) {
  const options = { arch: process.arch, target: null, skipBuild: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--arch") options.arch = argv[++i];
    else if (arg === "--target") options.target = argv[++i];
    else if (arg === "--skip-build") options.skipBuild = true;
    else throw new Error(`不認得的參數：${arg}`);
  }
  if (options.arch !== "x64" && options.arch !== "arm64") {
    throw new Error(`--arch 只能是 x64 或 arm64，目前是 ${options.arch}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const os = OS_MACRO[process.platform];
if (!os) throw new Error(`不支援的平台：${process.platform}`);
const crate = `${NAMES.productSlug}-runner`;
const binary = `${crate}${process.platform === "win32" ? ".exe" : ""}`;

if (!options.skipBuild) {
  // 參數以陣列傳給 spawn，不經過 shell
  const args = [
    "build",
    "--release",
    "-p",
    crate,
    ...(options.target ? ["--target", options.target] : []),
  ];
  console.log(`cargo ${args.join(" ")}`);
  const cargo = spawnSync("cargo", args, { cwd: repoRoot, stdio: "inherit" });
  if (cargo.status !== 0) process.exit(cargo.status ?? 1);
}

const source = join(
  repoRoot,
  "target",
  ...(options.target ? [options.target] : []),
  "release",
  binary,
);
const destinationDir = join(desktopDir, "build", "runner", `${os}-${options.arch}`);
rmSync(destinationDir, { recursive: true, force: true });
mkdirSync(destinationDir, { recursive: true });
copyFileSync(source, join(destinationDir, binary));
console.log(`Runner 已放到 ${join(destinationDir, binary)}`);
