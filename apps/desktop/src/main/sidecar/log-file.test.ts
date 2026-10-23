import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RotatingLogFile } from "./log-file";

describe("RotatingLogFile", () => {
  const dirs: string[] = [];
  const tempLog = () => {
    const dir = mkdtempSync(join(tmpdir(), "desktop-log-"));
    dirs.push(dir);
    return join(dir, "nested", "runner.log");
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("自動建立目錄並附加寫入", () => {
    const path = tempLog();
    const log = new RotatingLogFile(path, 1_000);
    log.write("第一行\n");
    log.write(Buffer.from("第二行\n"));
    log.close();
    new RotatingLogFile(path, 1_000).write("第三行\n");
    expect(readFileSync(path, "utf8")).toBe("第一行\n第二行\n第三行\n");
  });

  it("超過上限時輪替成 .1，只保留一份舊檔", () => {
    const path = tempLog();
    const log = new RotatingLogFile(path, 10);
    log.write("aaaaaaaa\n"); // 9 bytes
    log.write("bbbbbbbb\n"); // 超過 10 → 輪替
    log.write("cccccccc\n"); // 再輪替，aaaa 被丟掉
    log.close();
    expect(readFileSync(path, "utf8")).toBe("cccccccc\n");
    expect(readFileSync(`${path}.1`, "utf8")).toBe("bbbbbbbb\n");
    expect(existsSync(`${path}.2`)).toBe(false);
  });

  it("note() 標上 [desktop] 與時間", () => {
    const path = tempLog();
    const log = new RotatingLogFile(path);
    log.note("啟動 Runner");
    log.close();
    expect(readFileSync(path, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T.+ \[desktop\] 啟動 Runner\n$/);
  });
});
