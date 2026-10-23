// Run 狀態變化的程序內通知：阻塞的工具呼叫（`wait_run`、`ask_parent`）在這裡等，
// Event 套用後（commit 之後）由 EventIngest 與工具服務呼叫 changed()。
// 只是提早喚醒；等待的一方每次醒來都重新讀資料庫，所以漏掉的通知最多讓它等到下一次檢查。

export class RunWatch {
  private readonly waiters = new Map<string, Set<() => void>>();

  /** Run（或與它有關的問題）有變化。 */
  changed(runId: string): void {
    const set = this.waiters.get(runId);
    if (!set) return;
    this.waiters.delete(runId);
    for (const wake of set) wake();
  }

  /** 等到 runId 有變化或逾時；回傳 true 表示是被喚醒的。 */
  wait(runId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let set = this.waiters.get(runId);
      if (!set) {
        set = new Set();
        this.waiters.set(runId, set);
      }
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters.get(runId)?.delete(wake);
        resolve(false);
      }, timeoutMs);
      timer.unref();
      set.add(wake);
    });
  }
}
