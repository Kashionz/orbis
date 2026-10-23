// Transaction 與「commit 之後才做」的工作（例如發出 domain event、推送給 Runner）。

import type { Database } from "./client";

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** 可以下查詢的對象：資料庫本身或一個 transaction。 */
export type Executor = Database | Transaction;

export interface UnitOfWork {
  tx: Transaction;
  /** 登記在 commit 成功後才執行的工作；rollback 時不執行。 */
  afterCommit(fn: () => void | Promise<void>): void;
}

/** 在 transaction 中執行 fn，commit 後依序執行登記的工作。 */
export async function inTransaction<T>(
  db: Database,
  fn: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
  const after: (() => void | Promise<void>)[] = [];
  const result = await db.transaction((tx) => fn({ tx, afterCommit: (job) => after.push(job) }));
  for (const job of after) await job();
  return result;
}
