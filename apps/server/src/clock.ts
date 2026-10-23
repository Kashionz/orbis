// 時間來源。逾時與清理工作都透過它取得現在時間，測試可以換成手動推進的時鐘。

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** 測試用：時間只在呼叫 advance() 時前進。 */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date = new Date()) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
