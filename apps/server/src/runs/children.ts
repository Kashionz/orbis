// Child Run（ARCHITECTURE §9）的共用查詢：深度、序號、給父 Agent 看的摘要，以及父 Run 結束時連帶取消。

import type { ChildRunSummary, DelegationMode, Usage } from "@orbis/protocol";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { childQuestions, dispatches, runEvents, runs } from "../db/schema";
import type { Executor, UnitOfWork } from "../db/tx";
import { NON_TERMINAL_RUN_STATUSES } from "../domain/run-status";
import type { RunControlService } from "./run-control";

type RunRow = typeof runs.$inferSelect;

/** Run 的深度：頂層 Run 是 0，Child Run 是 1，Child Run 的 Child Run 是 2。 */
export async function runDepth(tx: Executor, run: Pick<RunRow, "parentRunId">): Promise<number> {
  let depth = 0;
  let parentId = run.parentRunId;
  while (parentId) {
    depth += 1;
    const [parent] = await tx
      .select({ parentRunId: runs.parentRunId })
      .from(runs)
      .where(eq(runs.id, parentId));
    parentId = parent?.parentRunId ?? null;
  }
  return depth;
}

/** Child Run 是父 Run 的第幾個 Child Run（依建立順序，從 1 開始），即分支名稱 `--c<n>` 的 n。 */
export async function childSequence(tx: Executor, child: RunRow): Promise<number> {
  if (!child.parentRunId) return 0;
  const siblings = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.parentRunId, child.parentRunId))
    .orderBy(asc(runs.createdAt), asc(runs.id));
  return siblings.findIndex((s) => s.id === child.id) + 1;
}

/** Child Run 最後的回覆（`final_message`）；內容放在 blob 時回傳 null。 */
async function finalMessage(tx: Executor, runId: string): Promise<string | null> {
  const [row] = await tx
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.kind, "final_message")))
    .orderBy(desc(runEvents.seq))
    .limit(1);
  const text = (row?.payload as { text?: { type: string; text?: string } } | undefined)?.text;
  return text?.type === "inline" ? (text.text ?? null) : null;
}

/** runs.usage（event-ingest 以 camelCase 存）轉回協定的 Usage；沒有回報時為 null。 */
function protocolUsage(usage: unknown): Usage | null {
  const u = usage as Record<string, unknown> | null;
  if (!u || Object.keys(u).length === 0) return null;
  const n = (key: string) => (typeof u[key] === "number" ? (u[key] as number) : null);
  return {
    input_tokens: n("inputTokens"),
    output_tokens: n("outputTokens"),
    thought_tokens: n("thoughtTokens"),
    cached_read_tokens: n("cachedReadTokens"),
    cached_write_tokens: n("cachedWriteTokens"),
    context_used_tokens: n("contextUsedTokens"),
    context_window_tokens: n("contextWindowTokens"),
    cost: (u.cost as Usage["cost"]) ?? null,
  };
}

/** 給父 Agent 看的 Child Run 狀態（`get_run`、`wait_run`、`list_runs`）。 */
export async function childRunSummary(tx: Executor, child: RunRow): Promise<ChildRunSummary> {
  const [question] = await tx
    .select({ id: childQuestions.id, question: childQuestions.question })
    .from(childQuestions)
    .where(and(eq(childQuestions.childRunId, child.id), isNull(childQuestions.answeredAt)))
    .orderBy(asc(childQuestions.askedAt))
    .limit(1);
  return {
    run_id: child.id,
    agent: child.agent,
    model: child.model,
    mode: (child.delegationMode ?? "consult") as DelegationMode,
    status: child.status,
    branch: child.branch,
    final_message: await finalMessage(tx, child.id),
    pending_question: question ? { question_id: question.id, question: question.question } : null,
    usage: protocolUsage(child.usage),
  };
}

/**
 * 父 Run 結束時，還沒結束的 Child Run 一併取消：還沒被 Runner 接受的直接結束，
 * 已在 Runner 上的送 cancel（Runner 端也會連同 Child Run 處理）。
 */
export async function cancelChildren(
  uow: UnitOfWork,
  parentRunId: string,
  runControls: RunControlService,
  now: Date,
): Promise<string[]> {
  const { tx } = uow;
  const children = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.parentRunId, parentRunId), inArray(runs.status, NON_TERMINAL_RUN_STATUSES)));
  const canceled: string[] = [];
  for (const child of children) {
    if (child.status === "queued" || child.status === "dispatched") {
      await tx
        .update(dispatches)
        .set({ status: "expired" })
        .where(and(eq(dispatches.runId, child.id), eq(dispatches.status, "offered")));
      await tx
        .update(runs)
        .set({ status: "canceled", finishedAt: now })
        .where(eq(runs.id, child.id));
      canceled.push(child.id);
    } else {
      try {
        await runControls.send(tx, child.id, { action: "cancel" }, uow);
      } catch {
        // 沒有在 Runner 上執行（例如剛好改派中）：直接結束。
        await tx
          .update(runs)
          .set({ status: "canceled", finishedAt: now })
          .where(eq(runs.id, child.id));
        canceled.push(child.id);
      }
    }
  }
  return canceled;
}
