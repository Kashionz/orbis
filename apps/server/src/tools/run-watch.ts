// Run 狀態變化的程序內通知：阻塞的工具呼叫（`wait_run`、`ask_parent`）在這裡等，
// Event 套用後（commit 之後）由 EventIngest 與工具服務呼叫 changed()。
// 只是提早喚醒；等待的一方每次醒來都重新讀資料庫，所以漏掉的通知最多讓它等到下一次檢查。
//
// 等待的一方要先 watch()、再讀資料庫、最後 wait()：讀取與 wait() 之間的 changed() 也會被記住。
// 先讀資料庫才登記的話，這段空檔裡的通知會漏掉，只能等到逾時或下一次檢查。

/** RunWatch 已關閉（Server 正在關閉），阻塞中的工具呼叫不再等待。 */
export class RunWatchClosedError extends Error {
  constructor() {
    super("RunWatch 已關閉");
    this.name = "RunWatchClosedError";
  }
}

/** 某個 key 的一次監看：從 watch() 開始的第一次變化。 */
export interface PendingChange {
  /**
   * 等到變化或逾時；回傳 true 表示有變化（包含 watch() 之後、呼叫 wait() 之前發生的）。
   * RunWatch 已關閉時丟出 RunWatchClosedError。
   */
  wait(timeoutMs: number): Promise<boolean>;
  /** 不再監看（讀完資料庫已經有結果時）。可以重複呼叫。 */
  cancel(): void;
}

export class RunWatch {
  private readonly listeners = new Map<string, Set<() => void>>();
  private closed = false;

  /** Run（或與它有關的問題）有變化。 */
  changed(runId: string): void {
    const set = this.listeners.get(runId);
    if (!set) return;
    this.listeners.delete(runId);
    for (const fire of set) fire();
  }

  /** 開始監看 key 的下一次變化。要在讀資料庫之前呼叫。 */
  watch(key: string): PendingChange {
    let changed = false;
    let wake: (() => void) | undefined;
    const fire = () => {
      changed = true;
      wake?.();
    };
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(fire);
    const cancel = () => {
      const current = this.listeners.get(key);
      if (!current?.delete(fire)) return;
      if (current.size === 0) this.listeners.delete(key);
    };
    return {
      wait: (timeoutMs) => {
        if (this.closed) {
          cancel();
          return Promise.reject(new RunWatchClosedError());
        }
        if (changed) return Promise.resolve(true);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            cancel();
            resolve(false);
          }, timeoutMs);
          timer.unref();
          wake = () => {
            clearTimeout(timer);
            if (this.closed) reject(new RunWatchClosedError());
            else resolve(true);
          };
        });
      },
      cancel,
    };
  }

  /** Server 關閉時呼叫：喚醒所有等待中的監看（丟出 RunWatchClosedError），之後的 wait() 也立刻丟出。 */
  close(): void {
    this.closed = true;
    for (const key of [...this.listeners.keys()]) this.changed(key);
  }
}
