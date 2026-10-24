// RunWatch（src/tools/run-watch.ts）：阻塞的工具呼叫（wait_run、ask_parent）等待 Run 變化的通知。

import { describe, expect, it } from "vitest";
import { RunWatch, RunWatchClosedError } from "../src/tools/run-watch";

describe("RunWatch", () => {
  it("watch() 之後、wait() 之前發生的變化不會漏掉（先讀資料庫、通知早於 wait 的競態）", async () => {
    const watch = new RunWatch();
    const change = watch.watch("run-1");
    // 讀資料庫的期間另一個工具呼叫 commit 並通知。
    watch.changed("run-1");
    const started = Date.now();
    await expect(change.wait(5000)).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("wait() 期間的變化會喚醒；其他 key 的變化不會", async () => {
    const watch = new RunWatch();
    const change = watch.watch("run-1");
    const waiting = change.wait(5000);
    watch.changed("run-2");
    watch.changed("run-1");
    await expect(waiting).resolves.toBe(true);
  });

  it("沒有變化時逾時回傳 false", async () => {
    const watch = new RunWatch();
    await expect(watch.watch("run-1").wait(20)).resolves.toBe(false);
  });

  it("cancel() 之後不再收到這個 key 的通知", async () => {
    const watch = new RunWatch();
    const change = watch.watch("run-1");
    change.cancel();
    change.cancel();
    watch.changed("run-1");
    await expect(change.wait(20)).resolves.toBe(false);
  });

  it("close() 讓等待中與之後的 wait() 都丟出 RunWatchClosedError", async () => {
    const watch = new RunWatch();
    const waiting = watch.watch("run-1").wait(60_000);
    watch.close();
    await expect(waiting).rejects.toBeInstanceOf(RunWatchClosedError);
    await expect(watch.watch("run-2").wait(60_000)).rejects.toBeInstanceOf(RunWatchClosedError);
  });
});
