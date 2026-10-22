import assert from "node:assert/strict";
import { test } from "node:test";
import { findViolations } from "./check-names.mjs";

test("字串中寫死名稱會被抓到", () => {
  const text = [
    'const title = "Orbis";',
    "const env = `ORBIS_PORT`;",
    "const dir = '.orbis/config.toml';",
    'const branch = "orbis/ORB-1-fix";',
    'const root = "C:\\\\ob";',
  ].join("\n");
  const found = findViolations("apps/web/src/a.ts", text).map((v) => v.line);
  assert.deepEqual(found, [1, 2, 3, 4, 5]);
});

test("註解、套件名稱與例外標記不算違規", () => {
  const text = [
    "// Orbis 的 Runner 會注入 ORBIS_PORT",
    'import { NAMES } from "@orbis/api-contract";',
    'import x from "../orbis-protocol";',
    'const legacy = "Orbis"; // names-check: allow',
  ].join("\n");
  assert.deepEqual(findViolations("apps/server/src/b.ts", text), []);
});

test("Rust 的 lifetime 不會被當成單引號字串", () => {
  const text = "fn f(x: &'static str) -> &'static str { x } // Orbis";
  assert.deepEqual(findViolations("crates/runner/src/c.rs", text), []);
  assert.equal(findViolations("crates/runner/src/c.rs", 'let n = "ORBIS_PORT";').length, 1);
});

test("名稱常數檔與非程式碼檔案不檢查", () => {
  assert.deepEqual(
    findViolations("crates/orbis-protocol/src/names.rs", 'const A: &str = "Orbis";'),
    [],
  );
  assert.deepEqual(
    findViolations("packages/api-contract/src/names.ts", 'productName: "Orbis",'),
    [],
  );
  assert.deepEqual(findViolations("docs/ARCHITECTURE.md", '"Orbis"'), []);
});
