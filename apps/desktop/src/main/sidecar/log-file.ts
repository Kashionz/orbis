// Runner 的 log 檔：超過大小上限時輪替成 `<檔名>.1`，只保留一份舊檔。

import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

export class RotatingLogFile {
  private fd: number | null = null;
  private size = 0;

  constructor(
    readonly path: string,
    private readonly maxBytes: number = DEFAULT_MAX_LOG_BYTES,
  ) {}

  /** 寫入一段原始輸出（stdout／stderr 的 chunk）。 */
  write(chunk: string | Buffer): void {
    const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (data.length === 0) return;
    const fd = this.open();
    if (this.size > 0 && this.size + data.length > this.maxBytes) {
      this.rotate();
      this.write(data);
      return;
    }
    writeSync(fd, data);
    this.size += data.length;
  }

  /** 寫入 Desktop 自己的一行訊息，加上時間與來源標記，方便和 Runner 的 log 區分。 */
  note(message: string): void {
    this.write(`${new Date().toISOString()} [desktop] ${message}\n`);
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  private open(): number {
    if (this.fd !== null) return this.fd;
    mkdirSync(dirname(this.path), { recursive: true });
    this.fd = openSync(this.path, "a");
    try {
      this.size = statSync(this.path).size;
    } catch {
      this.size = 0;
    }
    return this.fd;
  }

  private rotate(): void {
    this.close();
    const old = `${this.path}.1`;
    rmSync(old, { force: true });
    renameSync(this.path, old);
    this.size = 0;
  }
}
