#!/usr/bin/env node
// 檢查程式碼中沒有寫死產品名稱、設定目錄、環境變數前綴與 Worktree 根目錄。
// 這些值只能從名稱常數取得（Rust：orbis_protocol::names，TS：@orbis/api-contract/names）。
//
// 只檢查字串字面值；註解不受限制。確實需要例外的那一行，加上 `names-check: allow`。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".rs",
  ".html",
]);

/** 允許出現這些值的檔案：名稱常數本身與產生的型別。 */
const ALLOWED_FILES = [
  /^crates\/orbis-protocol\/src\/names\.rs$/,
  /^packages\/api-contract\/src\/names\.ts$/,
  /^packages\/protocol\/src\/generated\//,
  /^scripts\/check-names(\.test)?\.mjs$/,
  /^docs\/design\//, // 設計原型（Claude Design 匯出），不是產品程式碼
];

const FORBIDDEN = [
  { pattern: /\bOrbis\b/, what: "產品名稱" },
  { pattern: /ORBIS_/, what: "環境變數前綴" },
  { pattern: /\.orbis\b/, what: "設定目錄" },
  { pattern: /(^|[^@\w-])orbis\//, what: "分支前綴" },
  { pattern: /C:\\{1,2}ob\b/i, what: "Windows Worktree 根目錄" },
];

const ALLOW_MARKER = "names-check: allow";

// 雙引號、反引號字串，以及（非 Rust 檔案的）單引號字串。Rust 的單引號是 lifetime 或字元。
const DOUBLE_OR_BACKTICK = /"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const SINGLE = /'(?:[^'\\\n]|\\.)*'/g;

/**
 * 找出一個檔案中的違規。
 * @param {string} file repo 內的相對路徑（以 / 分隔）
 * @param {string} text 檔案內容
 * @returns {{ file: string, line: number, what: string, literal: string }[]}
 */
export function findViolations(file, text) {
  if (!CHECKED_EXTENSIONS.has(extname(file))) return [];
  if (ALLOWED_FILES.some((re) => re.test(file))) return [];

  const literalPatterns = file.endsWith(".rs")
    ? [DOUBLE_OR_BACKTICK]
    : [DOUBLE_OR_BACKTICK, SINGLE];
  const violations = [];
  text.split(/\r?\n/).forEach((lineText, index) => {
    if (lineText.includes(ALLOW_MARKER)) return;
    for (const literalPattern of literalPatterns) {
      for (const match of lineText.matchAll(literalPattern)) {
        const literal = match[0];
        // 每個字面值只回報第一個違規，例如 ".orbis/" 同時符合設定目錄與分支前綴
        const hit = FORBIDDEN.find(({ pattern }) => pattern.test(literal));
        if (hit) {
          violations.push({ file, line: index + 1, what: hit.what, literal });
        }
      }
    }
  });
  return violations;
}

function listFiles(root) {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const violations = [];
  for (const file of listFiles(root)) {
    let text;
    try {
      text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    } catch {
      continue; // 已刪除但尚未 commit 的檔案
    }
    violations.push(...findViolations(file, text));
  }
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}:${v.line}: 寫死了${v.what}：${v.literal}`);
    }
    console.error(
      `\n共 ${violations.length} 處。請改用名稱常數，或在該行加上 \`${ALLOW_MARKER}\`。`,
    );
    process.exit(1);
  }
  console.log("check-names: OK");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
