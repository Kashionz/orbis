// 本機 Repo 的 Spec 提交（ARCHITECTURE §12.1、ADR-0013）：Server 碰不到本機 checkout，所以把內容交給提交者
// 自己的 Local Runner（frame `repo_spec_commit`），等它回報 `repo_spec_commit_result`。

import type { RepoSpecCommit, RepoSpecCommitOutcome } from "@orbis/protocol";
import { v7 as uuidv7 } from "uuid";
import type { RunnerHub } from "./hub";

/** 等 Runner 回報的時間。 */
export const REPO_SPEC_COMMIT_TIMEOUT_MS = 60_000;

export type RepoSpecCommitResult =
  | { ok: true; outcome: RepoSpecCommitOutcome }
  | { ok: false; reason: "runner_offline" | "timeout" };

interface Pending {
  runnerId: string;
  resolve: (result: RepoSpecCommitResult) => void;
  timer: NodeJS.Timeout;
}

export class RepoSpecCommits {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly hub: RunnerHub,
    private readonly timeoutMs = REPO_SPEC_COMMIT_TIMEOUT_MS,
  ) {}

  /** 送出提交並等結果；Runner 不在線或逾時時回 ok: false。 */
  request(
    runnerId: string,
    commit: Omit<RepoSpecCommit, "commit_id">,
  ): Promise<RepoSpecCommitResult> {
    const commitId = uuidv7();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(commitId);
        resolve({ ok: false, reason: "timeout" });
      }, this.timeoutMs);
      this.pending.set(commitId, { runnerId, resolve, timer });
      const sent = this.hub.send(runnerId, {
        type: "repo_spec_commit",
        commit_id: commitId,
        ...commit,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(commitId);
        resolve({ ok: false, reason: "runner_offline" });
      }
    });
  }

  /** Runner 的回報：只接受送給這台 Runner 的提交。 */
  onResult(runnerId: string, result: { commit_id: string } & RepoSpecCommitOutcome): void {
    const entry = this.pending.get(result.commit_id);
    if (!entry || entry.runnerId !== runnerId) return;
    this.pending.delete(result.commit_id);
    clearTimeout(entry.timer);
    const { commit_id: _id, ...outcome } = result;
    entry.resolve({ ok: true, outcome: outcome as RepoSpecCommitOutcome });
  }
}
