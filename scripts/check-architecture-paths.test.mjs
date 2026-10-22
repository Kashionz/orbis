import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { componentPaths } from "./check-architecture-paths.mjs";

test("取出 §3 表格的路徑欄", () => {
  const markdown = [
    "## 2. 系統拓樸",
    "| 不是這張表 | `nope` | x |",
    "## 3. 元件與技術棧",
    "",
    "| 元件 | 路徑 | 技術 |",
    "|---|---|---|",
    "| Runner | `crates/runner` | Rust、`tokio` |",
    "| Web UI | `apps/web` | React |",
    "## 4. 領域模型",
  ].join("\n");
  assert.deepEqual(componentPaths(markdown), ["crates/runner", "apps/web"]);
});

test("找不到章節或路徑時報錯", () => {
  assert.throws(() => componentPaths("## 1. 產品定位\n"), /找不到/);
  assert.throws(() => componentPaths("## 3. 元件與技術棧\n沒有表格\n"), /沒有任何路徑/);
});

test("實際的 ARCHITECTURE.md 列出所有元件", () => {
  const markdown = readFileSync(new URL("../docs/ARCHITECTURE.md", import.meta.url), "utf8");
  const paths = componentPaths(markdown);
  for (const expected of ["crates/orbis-protocol", "apps/server", "packages/api-contract"]) {
    assert.ok(paths.includes(expected), `缺少 ${expected}`);
  }
});
