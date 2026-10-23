// Dispatch 佇列（ARCHITECTURE §6.1）。
//
// 派工規則：
// - `local` 的 Run 只交給派工者自己的 Local Runner；Local Runner 離線時 Run 留在佇列，不轉給 Team Runner。
// - `team` 的 Run 交給同一個 Team 的 Team Runner。
// - Runner 必須在線上、接受新的 Dispatch（Heartbeat 的 accepting_dispatches），而且回報該 Agent 可用。
//   連線後要等第一個 Heartbeat 才知道是否接受，所以在那之前不派工。
//
// 逾時：
// - Offer 在 expires_at 之前沒有回覆 → Dispatch `expired`，Run 回到佇列。
// - 超過 3 個心跳間隔沒有 Heartbeat → 這台 Runner 上進行中的 Dispatch 全部 `expired`，Run 回到佇列重新派工
//   （新的 Offer 帶 last_event_seq）。逾時前重新連上就沿用原本的 Dispatch。
//
// 並行上限的完整控管留給 B2。

import { NAMES, type QueueWaitingReason } from "@orbis/api-contract";
import type {
  ContentBlock,
  DispatchAccept,
  DispatchOffer,
  DispatchReject,
  RunResume,
} from "@orbis/protocol";
import { and, asc, count, eq, gt, inArray, isNull, lt, lte, or } from "drizzle-orm";
import type { Clock } from "../clock";
import type { Database } from "../db/client";
import {
  acceptanceCriteria,
  agentAvailabilities,
  dispatches,
  projects,
  repoSpecs,
  repos,
  runnerCredentials,
  runners,
  runs,
  tasks,
} from "../db/schema";
import type { Executor } from "../db/tx";
import { isPrimaryRun, NON_TERMINAL_RUN_STATUSES } from "../domain/run-status";
import { planGateEnabled } from "../domain/task-lifecycle";
import type { Logger } from "../logger";
import { childSequence, runDepth } from "../runs/children";
import type { EventStore } from "../runs/event-store";
import {
  CREDENTIAL_OCCUPYING_STATUSES,
  type CredentialLoad,
  credentialCapacity,
  effectiveMaxConcurrency,
} from "./capacity";
import type { RunnerHub } from "./hub";

export const DEFAULT_OFFER_TIMEOUT_MS = 30_000;
/** 幾個心跳間隔沒有 Heartbeat 就視為離線。 */
export const HEARTBEAT_TIMEOUT_INTERVALS = 3;
/** Runner 拒絕某個 Run 之後，多久內不再把同一個 Run 派給它。 */
export const DEFAULT_REJECT_COOLDOWN_MS = 60_000;

export interface DispatcherOptions {
  db: Database;
  hub: RunnerHub;
  eventStore: EventStore;
  clock: Clock;
  logger: Logger;
  heartbeatIntervalMs: number;
  offerTimeoutMs?: number;
  rejectCooldownMs?: number;
}

type RunRow = typeof runs.$inferSelect;

/** 派工的結果：派給哪台 Runner、用哪組 Credential，或還在佇列的原因。 */
export type Placement =
  | { runnerId: string; credential: string | null }
  | { reason: QueueWaitingReason };

/** 一組 Credential 目前的負載：佔用名額的 Run、有效上限與 rate limit。 */
export async function credentialLoad(
  db: Executor,
  runnerId: string,
  credential: string,
  reported: number,
): Promise<CredentialLoad> {
  const [settings] = await db
    .select()
    .from(runnerCredentials)
    .where(
      and(eq(runnerCredentials.runnerId, runnerId), eq(runnerCredentials.credential, credential)),
    );
  const [{ active } = { active: 0 }] = await db
    .select({ active: count() })
    .from(runs)
    .where(
      and(
        eq(runs.runnerId, runnerId),
        eq(runs.credential, credential),
        inArray(runs.status, [...CREDENTIAL_OCCUPYING_STATUSES]),
      ),
    );
  return {
    maxConcurrency: effectiveMaxConcurrency(settings?.maxConcurrentRunsOverride, reported),
    active,
    rateLimitedUntil: settings?.rateLimitedUntil ?? null,
  };
}

export class Dispatcher {
  private readonly db: Database;
  private readonly log: Logger;
  private readonly offerTimeoutMs: number;
  private readonly rejectCooldownMs: number;
  /** `${runId}:${runnerId}` → 冷卻結束的時間。 */
  private readonly cooldowns = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private scheduled = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: DispatcherOptions) {
    this.db = options.db;
    this.log = options.logger.child({ component: "dispatcher" });
    this.offerTimeoutMs = options.offerTimeoutMs ?? DEFAULT_OFFER_TIMEOUT_MS;
    this.rejectCooldownMs = options.rejectCooldownMs ?? DEFAULT_REJECT_COOLDOWN_MS;
  }

  /** 啟動定期檢查（逾時與佇列）。 */
  start(intervalMs = 1000): void {
    this.stop();
    this.timer = setInterval(() => this.kick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 要求跑一輪檢查；多次呼叫會合併成一次，並依序執行。 */
  kick(): Promise<void> {
    if (this.scheduled) return this.chain;
    this.scheduled = true;
    this.chain = this.chain.then(async () => {
      this.scheduled = false;
      try {
        await this.pass();
      } catch (error) {
        this.log.error({ err: error }, "派工檢查失敗");
      }
    });
    return this.chain;
  }

  /** 等目前排定的檢查跑完（測試用）。 */
  idle(): Promise<void> {
    return this.chain;
  }

  /**
   * Runner 送出新的 AgentAvailability 時，解除它的拒絕冷卻。
   * 連線後的第一個 Heartbeat 之前（還不知道是否暫停領取）只記錄，不觸發派工；
   * 第一個 Heartbeat 由 endpoint 觸發派工。
   */
  availabilityChanged(runnerId: string): void {
    for (const key of this.cooldowns.keys()) {
      if (key.endsWith(`:${runnerId}`)) this.cooldowns.delete(key);
    }
    if (this.options.hub.isAcceptingDispatches(runnerId)) void this.kick();
  }

  private async pass(): Promise<void> {
    const now = this.options.clock.now();
    await this.expireOffers(now);
    await this.expireSilentRunners(now);
    await this.dispatchQueued(now);
  }

  /** Offer 過期沒有回覆。 */
  private async expireOffers(now: Date): Promise<void> {
    const expired = await this.db
      .update(dispatches)
      .set({ status: "expired" })
      .where(and(eq(dispatches.status, "offered"), lte(dispatches.expiresAt, now)))
      .returning({ id: dispatches.id, runId: dispatches.runId, runnerId: dispatches.runnerId });
    for (const dispatch of expired) {
      this.log.info(dispatch, "Dispatch Offer 逾時未回覆");
      await this.requeue(this.db, dispatch.runId);
    }
  }

  /** 超過心跳逾時的 Runner：進行中的 Dispatch 全部過期，Run 回到佇列。 */
  private async expireSilentRunners(now: Date): Promise<void> {
    const threshold = new Date(
      now.getTime() - HEARTBEAT_TIMEOUT_INTERVALS * this.options.heartbeatIntervalMs,
    );
    const silent = await this.db
      .select({ id: runners.id })
      .from(runners)
      .innerJoin(dispatches, eq(dispatches.runnerId, runners.id))
      .where(
        and(
          inArray(dispatches.status, ["offered", "accepted"]),
          or(
            lt(runners.lastHeartbeatAt, threshold),
            and(isNull(runners.lastHeartbeatAt), lt(runners.lastConnectedAt, threshold)),
            isNull(runners.lastConnectedAt),
          ),
        ),
      )
      .groupBy(runners.id);
    for (const { id } of silent) {
      this.log.warn({ runnerId: id }, "Runner Heartbeat 逾時，改派它的 Run");
      this.options.hub.disconnect(id, 4002, "heartbeat timeout");
      await this.expireRunnerDispatches(id);
    }
  }

  /** 讓 Runner 上進行中的 Dispatch 全部過期（Heartbeat 逾時、撤銷 Runner）。 */
  async expireRunnerDispatches(runnerId: string): Promise<void> {
    const expired = await this.db
      .update(dispatches)
      .set({ status: "expired" })
      .where(
        and(eq(dispatches.runnerId, runnerId), inArray(dispatches.status, ["offered", "accepted"])),
      )
      .returning({ runId: dispatches.runId });
    for (const { runId } of expired) await this.requeue(this.db, runId);
    if (expired.length > 0) void this.kick();
  }

  /** 讓還沒結束的 Run 回到佇列。 */
  private async requeue(db: Executor, runId: string): Promise<void> {
    await db
      .update(runs)
      .set({ status: "queued", runnerId: null, credential: null })
      .where(and(eq(runs.id, runId), inArray(runs.status, NON_TERMINAL_RUN_STATUSES)));
  }

  private async dispatchQueued(now: Date): Promise<void> {
    const queued = await this.db
      .select()
      .from(runs)
      .where(eq(runs.status, "queued"))
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .limit(100);
    for (const run of queued) {
      const placement = await this.placement(run, now);
      if ("runnerId" in placement) {
        await this.offer(run, placement.runnerId, placement.credential, now);
      }
    }
  }

  /**
   * 這個 Run 現在能派給哪台 Runner、用哪組 Credential；不能派時回傳原因（Team Runner 佇列的顯示也用它）。
   * Credential 的有效並行上限＝Admin 的覆寫 ?? Runner 回報；撞到 rate limit 時到恢復前不派（ARCHITECTURE §7）。
   */
  async placement(run: RunRow, now: Date): Promise<Placement> {
    if (run.target === "local" && !run.requestedByMemberId) return { reason: "no_runner" };
    const [owner] = await this.db
      .select({ teamId: projects.teamId })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(tasks.id, run.taskId));
    if (!owner) return { reason: "no_runner" };
    // Child Run、讀別的 Run Worktree 的 consult Run、Feedback Loop 接續的 Run 只能派給那個 Run 所在的
    // Runner（要用同一個 Worktree）。那個 Run 不在任何 Runner 上時留在佇列。
    const pinned = run.parentRunId ?? run.consultOfRunId ?? run.resumesRunId;
    let pinnedRunnerId: string | undefined;
    if (pinned) {
      const [source] = await this.db
        .select({ runnerId: runs.runnerId })
        .from(runs)
        .where(eq(runs.id, pinned));
      if (!source?.runnerId) return { reason: "no_runner" };
      pinnedRunnerId = source.runnerId;
    }
    const eligible = and(
      eq(runners.teamId, owner.teamId),
      isNull(runners.revokedAt),
      eq(runners.kind, run.target),
      pinnedRunnerId ? eq(runners.id, pinnedRunnerId) : undefined,
      run.target === "local" && run.requestedByMemberId
        ? eq(runners.memberId, run.requestedByMemberId)
        : undefined,
    );
    const candidates = await this.db
      .select({
        id: runners.id,
        credential: agentAvailabilities.credential,
        reported: agentAvailabilities.maxConcurrency,
      })
      .from(runners)
      .innerJoin(agentAvailabilities, eq(agentAvailabilities.runnerId, runners.id))
      .where(
        and(
          eligible,
          eq(agentAvailabilities.agent, run.agent),
          eq(agentAvailabilities.available, true),
        ),
      )
      .orderBy(asc(runners.createdAt), asc(runners.id), asc(agentAvailabilities.credential));
    if (candidates.length === 0) {
      const [any] = await this.db.select({ id: runners.id }).from(runners).where(eligible).limit(1);
      return { reason: any ? "agent_unavailable" : "no_runner" };
    }
    let blocked: "concurrency_limit" | "rate_limited" | null = null;
    let reachable = false;
    for (const candidate of candidates) {
      if (!this.options.hub.isOnline(candidate.id)) continue;
      if (!this.options.hub.isAcceptingDispatches(candidate.id)) continue;
      const cooldown = this.cooldowns.get(`${run.id}:${candidate.id}`);
      if (cooldown !== undefined && cooldown > now.getTime()) continue;
      reachable = true;
      // 沒有 Credential 的 Agent 不受 Server 的並行上限限制（Runner 自己仍會檢查）。
      if (candidate.credential === "") return { runnerId: candidate.id, credential: null };
      const capacity = credentialCapacity(
        await credentialLoad(this.db, candidate.id, candidate.credential, candidate.reported),
        now,
      );
      if (capacity.ok) return { runnerId: candidate.id, credential: candidate.credential };
      if (blocked !== "rate_limited") blocked = capacity.reason;
    }
    if (!reachable) return { reason: "no_runner" };
    return { reason: blocked ?? "concurrency_limit" };
  }

  /** 建立 Dispatch 並送出 Offer。 */
  private async offer(
    run: RunRow,
    runnerId: string,
    credential: string | null,
    now: Date,
  ): Promise<void> {
    const expiresAt = new Date(now.getTime() + this.offerTimeoutMs);
    const dispatch = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(runs)
        .set({ status: "dispatched", runnerId, credential })
        .where(and(eq(runs.id, run.id), eq(runs.status, "queued")))
        .returning({ id: runs.id });
      if (!claimed) return null;
      const [row] = await tx
        .insert(dispatches)
        .values({ runId: run.id, runnerId, expiresAt })
        .returning();
      return row ?? null;
    });
    if (!dispatch) return;

    const offer = await this.buildOffer({ ...run, runnerId, credential }, dispatch.id, expiresAt);
    const sent = this.options.hub.send(runnerId, { type: "dispatch_offer", ...offer });
    this.log.info(
      { runId: run.id, runnerId, dispatchId: dispatch.id, sent },
      "送出 Dispatch Offer",
    );
    if (!sent) {
      await this.db
        .update(dispatches)
        .set({ status: "expired" })
        .where(and(eq(dispatches.id, dispatch.id), eq(dispatches.status, "offered")));
      await this.requeue(this.db, run.id);
    }
  }

  async buildOffer(run: RunRow, dispatchId: string, expiresAt: Date): Promise<DispatchOffer> {
    const [row] = await this.db
      .select({ task: tasks, repo: repos, project: projects })
      .from(tasks)
      .innerJoin(repos, eq(repos.id, tasks.repoId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(tasks.id, run.taskId));
    if (!row) throw new Error(`Run ${run.id} 的 Task 或 Repo 不存在`);
    const { task, repo, project } = row;
    const criteria = await this.db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.taskId, task.id))
      .orderBy(asc(acceptanceCriteria.position));
    const defaultBranch = repo.defaultBranch ?? "main";
    return {
      dispatch_id: dispatchId,
      run_id: run.id,
      expires_at: expiresAt.toISOString(),
      task: { task_id: task.id, task_key: task.key, title: task.title },
      run_seq: await runSequence(this.db, run),
      repo: {
        name: repo.githubName,
        clone_url: `https://github.com/${repo.githubOwner}/${repo.githubName}.git`,
        default_branch: defaultBranch,
        base_ref: `origin/${defaultBranch}`,
      },
      branch: run.branch,
      agent: run.agent,
      model: run.model,
      permission_policy: run.permissionPolicy,
      // Child Run、@agent、Feedback Loop 的 Run 有自己的 prompt；其他 Run 由 Task 組出。
      prompt: (run.prompt as ContentBlock[] | null) ?? (await buildPrompt(this.db, task)),
      ...(run.promptSource && { prompt_source: run.promptSource }),
      // 只有主 Run 會經過 Planning 與 Plan Gate（ARCHITECTURE §5）。
      plan_gate: isPrimaryRun(run) && run.origin === "dispatch" && planGateEnabled(task, project),
      delegation:
        run.parentRunId && run.delegationMode
          ? {
              parent_run_id: run.parentRunId,
              mode: run.delegationMode,
              depth: await runDepth(this.db, run),
              child_seq: await childSequence(this.db, run),
            }
          : null,
      ...(run.consultOfRunId && { consult_of_run_id: run.consultOfRunId }),
      ...(await this.continuation(run)),
      last_event_seq: await this.options.eventStore.lastContiguousSeq(run.id),
      acceptance_criteria: criteria.map((c) => ({
        criterion_id: c.id,
        kind: c.kind,
        description: c.description,
        // command 為 null 時 Runner 沿用 Repo 設定檔的 `[verify].commands`。
        command: c.kind === "command" ? c.command : null,
      })),
      origin: run.origin,
      ...(run.credential && { credential: run.credential }),
    };
  }

  /** Feedback Loop 接續的 Run：沿用前一個 Run 的 Worktree、session 與 base commit（ARCHITECTURE §5.2）。 */
  private async continuation(run: RunRow): Promise<Pick<DispatchOffer, "continuation">> {
    if (!run.resumesRunId) return {};
    const [previous] = await this.db.select().from(runs).where(eq(runs.id, run.resumesRunId));
    if (!previous?.baseCommit) return {};
    return {
      continuation: {
        previous_run_id: previous.id,
        session_id: previous.agentSessionId,
        base_commit: previous.baseCommit,
      },
    };
  }

  /** Runner 接受 Offer，回傳接受的 Dispatch。過期或不屬於這台 Runner 的 Dispatch 一律忽略（回傳 null）。 */
  async onAccept(
    runnerId: string,
    accept: DispatchAccept,
  ): Promise<{ id: string; runId: string } | null> {
    const now = this.options.clock.now();
    const accepted = await this.db.transaction(async (tx) => {
      const [dispatch] = await tx
        .update(dispatches)
        .set({ status: "accepted", respondedAt: now })
        .where(
          and(
            eq(dispatches.id, accept.dispatch_id),
            eq(dispatches.runnerId, runnerId),
            eq(dispatches.status, "offered"),
            gt(dispatches.expiresAt, now),
          ),
        )
        .returning();
      if (!dispatch) return null;
      await tx
        .update(runs)
        .set({ status: "starting" })
        .where(and(eq(runs.id, dispatch.runId), eq(runs.status, "dispatched")));
      return dispatch;
    });
    if (!accepted) {
      this.log.warn(
        { runnerId, dispatchId: accept.dispatch_id },
        "忽略過期或不明的 dispatch_accept",
      );
      return null;
    }
    this.log.info(
      { runnerId, dispatchId: accepted.id, runId: accepted.runId },
      "Runner 接受 Dispatch",
    );
    return { id: accepted.id, runId: accepted.runId };
  }

  /** Runner 拒絕 Offer：Run 回到佇列，冷卻期間不再派給同一台 Runner。 */
  async onReject(runnerId: string, reject: DispatchReject): Promise<void> {
    const now = this.options.clock.now();
    const [dispatch] = await this.db
      .update(dispatches)
      .set({ status: "rejected", respondedAt: now, rejectReason: reject.reason })
      .where(
        and(
          eq(dispatches.id, reject.dispatch_id),
          eq(dispatches.runnerId, runnerId),
          eq(dispatches.status, "offered"),
        ),
      )
      .returning();
    if (!dispatch) {
      this.log.warn(
        { runnerId, dispatchId: reject.dispatch_id },
        "忽略過期或不明的 dispatch_reject",
      );
      return;
    }
    this.log.info(
      { runnerId, runId: dispatch.runId, reason: reject.reason, message: reject.message },
      "Runner 拒絕 Dispatch",
    );
    this.cooldowns.set(`${dispatch.runId}:${runnerId}`, now.getTime() + this.rejectCooldownMs);
    await this.requeue(this.db, dispatch.runId);
    void this.kick();
  }

  /** hello_ack 的 resume：這台 Runner 目前負責的 Run 已收到的最後 seq。 */
  async resumeFor(runnerId: string): Promise<RunResume[]> {
    const active = await this.db
      .select({ runId: dispatches.runId })
      .from(dispatches)
      .where(and(eq(dispatches.runnerId, runnerId), eq(dispatches.status, "accepted")));
    const resume: RunResume[] = [];
    for (const { runId } of active) {
      resume.push({
        run_id: runId,
        last_seq: await this.options.eventStore.lastContiguousSeq(runId),
      });
    }
    return resume;
  }
}

/** Run 在 Task 中的序號（頂層 Run，依建立順序，從 1 開始）。 */
export async function runSequence(db: Executor, run: RunRow): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(runs)
    .where(and(eq(runs.taskId, run.taskId), isNull(runs.parentRunId), lte(runs.id, run.id)));
  return Math.max(1, row?.n ?? 1);
}

/** 分支 slug 的最大長度（以字元計，不是 UTF-16 code unit）。 */
const BRANCH_SLUG_MAX_CHARS = 40;

/**
 * Task 標題的分支 slug：NFKC 正規化後只保留字母與數字（含中文等 Unicode 字母，不做音譯），
 * 其他字元一律換成 `-`，最多 BRANCH_SLUG_MAX_CHARS 個字元；全是符號時退回 `task`。
 * 結果只含 `\p{L}`、`\p{N}` 與 `-`，所以不會出現 git 不允許的 `..`、`@{`、結尾的 `.lock`、
 * 控制字元與空白。
 */
export function branchSlug(title: string): string {
  const slug = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const truncated = Array.from(slug).slice(0, BRANCH_SLUG_MAX_CHARS).join("").replace(/-+$/g, "");
  return truncated || "task";
}

/**
 * Run 的分支名稱：`<分支前綴><Task Key>-<slug>`（ARCHITECTURE §6.2）。
 * 同一個 Task 的第 2 個以後的 Run 加上 `-r<序號>`，避免與前一個 Run 的分支衝突。
 */
export function branchName(taskKey: string, title: string, runSeq: number): string {
  const suffix = runSeq > 1 ? `-r${runSeq}` : "";
  return `${NAMES.branchPrefix}${taskKey}-${branchSlug(title)}${suffix}`;
}

/** 送給 Agent 的第一個 prompt：Task 標題、描述、Spec 連結與 Acceptance Criterion。 */
export async function buildPrompt(
  db: Executor,
  task: typeof tasks.$inferSelect,
): Promise<ContentBlock[]> {
  const criteria = await db
    .select()
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.taskId, task.id))
    .orderBy(asc(acceptanceCriteria.position));
  const lines = [`# ${task.key} ${task.title}`, ""];
  if (task.description.trim() !== "") lines.push(task.description.trim(), "");
  if (criteria.length > 0) {
    lines.push("## Acceptance Criterion", "");
    for (const c of criteria) {
      const command = c.command ? `（指令：\`${c.command}\`）` : "";
      lines.push(`- [${c.kind}] ${c.description}${command}`);
    }
  }
  const blocks: ContentBlock[] = [{ type: "text", text: lines.join("\n").trimEnd() }];
  if (task.repoSpecId) {
    const [spec] = await db.select().from(repoSpecs).where(eq(repoSpecs.id, task.repoSpecId));
    if (spec) blocks.push({ type: "resource_link", uri: spec.path, name: spec.title ?? spec.path });
  }
  return blocks;
}
