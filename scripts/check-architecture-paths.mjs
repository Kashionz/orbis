#!/usr/bin/env node
// 檢查 docs/ARCHITECTURE.md §3「元件與技術棧」表格中的路徑都真的存在。
// 改動目錄結構時，要在同一個 PR 內一併更新 ARCHITECTURE（CLAUDE.md「完成的定義」）。

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 從 ARCHITECTURE.md 的內容取出 §3 表格第二欄（路徑）中以反引號標記的路徑。
 * @param {string} markdown
 * @returns {string[]}
 */
export function componentPaths(markdown) {
  const section = markdown.split(/^## /m).find((s) => s.startsWith("3. "));
  if (!section) throw new Error("ARCHITECTURE.md 找不到「## 3.」章節");
  const paths = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // cells[0] 是行首 | 之前的空字串；cells[2] 是「路徑」欄
    const match = cells[2]?.match(/^`([^`]+)`$/);
    if (match?.[1]) paths.push(match[1]);
  }
  if (paths.length === 0) throw new Error("§3 表格中沒有任何路徑");
  return paths;
}

function main() {
  const root = new URL("..", import.meta.url);
  const markdown = readFileSync(new URL("docs/ARCHITECTURE.md", root), "utf8");
  const missing = componentPaths(markdown).filter(
    (p) => !existsSync(fileURLToPath(new URL(p, root))),
  );
  if (missing.length > 0) {
    console.error(`ARCHITECTURE.md §3 列出的路徑不存在：${missing.join("、")}`);
    process.exit(1);
  }
  console.log("check-architecture-paths: OK");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
