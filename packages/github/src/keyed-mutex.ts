// 依 key 序列化非同步工作，例如同一個 Task 的同步同時只跑一個，避免重複建立 Issue。
// 只在單一 Server 程序內有效（Phase 1 的部署只有一個 Server）。

export class KeyedMutex {
  readonly #tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(work);
    const tail = result.catch(() => {});
    this.#tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
