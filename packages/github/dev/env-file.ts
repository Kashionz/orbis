// dev 腳本共用：讀寫 repo 根目錄的 .env（只放在本機，不會被 commit）。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

/** 讀取 .env 成 key/value；沒有檔案時回傳空物件。 */
export function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1]) values[match[1]] = (match[2] ?? "").replace(/^"(.*)"$/, "$1");
  }
  return values;
}

/** 更新或新增 .env 中的變數，其他行原樣保留。值中的換行寫成 `\n`。 */
export function writeEnvValues(values: Record<string, string>): void {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  const pending = new Map(Object.entries(values));
  const quote = (v: string) => `"${v.replace(/\r?\n/g, "\\n")}"`;
  const next = lines.map((line) => {
    const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
    if (!key || !pending.has(key)) return line;
    const value = pending.get(key) ?? "";
    pending.delete(key);
    return `${key}=${quote(value)}`;
  });
  while (next.length > 0 && next.at(-1) === "") next.pop();
  for (const [key, value] of pending) next.push(`${key}=${quote(value)}`);
  writeFileSync(ENV_FILE, `${next.join("\n")}\n`);
}
