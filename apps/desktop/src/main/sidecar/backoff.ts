// sidecar 當掉後重啟的指數退避。

export interface BackoffOptions {
  /** 第一次重啟前等待的時間。 */
  initialMs: number;
  /** 等待時間的上限。 */
  maxMs: number;
  /** 程序連續正常運作超過這段時間後才結束，退避就重置回 initialMs。 */
  resetAfterMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 1_000,
  maxMs: 60_000,
  resetAfterMs: 60_000,
};

export class Backoff {
  private attempt = 0;

  constructor(private readonly options: BackoffOptions = DEFAULT_BACKOFF) {}

  /**
   * 程序結束後呼叫，回傳下一次重啟前要等待的毫秒數。
   * @param uptimeMs 這次程序從啟動到結束經過的時間
   */
  next(uptimeMs: number): number {
    if (uptimeMs >= this.options.resetAfterMs) this.attempt = 0;
    const delay = Math.min(this.options.initialMs * 2 ** this.attempt, this.options.maxMs);
    this.attempt += 1;
    return delay;
  }

  reset(): void {
    this.attempt = 0;
  }
}
