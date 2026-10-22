// 測試用的時鐘。FakeGitHub 與 FakeDomainService 共用，讓 updated_at 的先後可以控制。

export class TestClock {
  #ms: number;

  constructor(start = "2026-10-23T08:00:00.000Z") {
    this.#ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#ms);
  }

  advance(ms: number): Date {
    this.#ms += ms;
    return this.now();
  }

  /** GitHub 的時間只到秒。 */
  githubTimestamp(): string {
    return `${this.now().toISOString().slice(0, 19)}Z`;
  }
}
