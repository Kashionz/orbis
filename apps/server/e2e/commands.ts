// 經由 stdin 對 e2e:stack 下指令（ready.ts 的 StackCommand）：每行一個 JSON，stack 在 stdout 回一行
// StackReply，以 `id` 對應。ready 行與回覆都走 stdout（其他 log 走 stderr），所以這裡接手整個 stdout
// 的行解析：ready 行之後的每一行都是回覆。

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { parseStackReply, type StackCommand, type StackReply } from "./ready";

type Pending = { resolve: (reply: StackReply) => void; reject: (error: Error) => void };

/** 對 union 的每個成員分別 Omit（一般的 Omit 會把 union 壓成共同的欄位）。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 送給 stack 的指令（`id` 由這裡產生）。 */
export type StackCommandInput = DistributiveOmit<StackCommand, "id">;

export class StackCommander {
  private readonly pending = new Map<string, Pending>();
  private closed: Error | null = null;

  /**
   * 接上 stack 的子程序。要在 ready 行之後建立：ready 行是以 `data` 事件讀的，之後的輸出由這裡的
   * readline 接手（同一個 stream 可以同時有兩種 listener，ready 的 listener 只是不再解析）。
   */
  constructor(private readonly child: ChildProcess) {
    if (!child.stdout || !child.stdin) throw new Error("stack 的 stdio 不是 pipe");
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => {
      const reply = parseStackReply(line);
      if (!reply) return;
      const waiting = this.pending.get(reply.reply);
      if (!waiting) return;
      this.pending.delete(reply.reply);
      waiting.resolve(reply);
    });
    child.once("exit", (code) => {
      this.closed = new Error(`stack 已結束（${code}）`);
      for (const waiting of this.pending.values()) waiting.reject(this.closed);
      this.pending.clear();
    });
  }

  /** 送出指令並等回覆；stack 回 `ok: false` 時丟出錯誤。 */
  async send<T = unknown>(command: StackCommandInput, timeoutMs = 30_000): Promise<T> {
    if (this.closed) throw this.closed;
    const id = randomUUID();
    const reply = await new Promise<StackReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`等待 stack 回覆 ${command.command} 逾時`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin?.write(`${JSON.stringify({ id, ...command })}\n`);
    });
    if (!reply.ok)
      throw new Error(`stack 的 ${command.command} 失敗：${reply.error ?? "原因不明"}`);
    return reply.result as T;
  }
}
