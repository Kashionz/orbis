// 執行中切換的設定與換 Agent 的分段（ARCHITECTURE §7、ADR-0016）。
//
// - `runs.agent`、`runs.model`、`runs.effort` 是目前的值：`run_settings_changed`、`agent_switched` 生效時更新。
// - `runs.permission_policy` 保留派工時的值；目前的 Permission Policy 由最後一筆生效的 `run_settings_changed`
//   算出（currentPermissionPolicy），改派、Delegation 與 Feedback Loop 都用目前的值。
// - 用量依 Agent 分段（run_agent_segments）：Runner 接受第一個 Dispatch 時建立第一段，`agent_switched` 結束目前這段、
//   開新的一段；`usage` Event 是目前這段從 0 開始的累計值，`runs.usage` 是所有段的合計。

import type {
  Effort,
  PermissionPolicy,
  RunSettings,
  RunSettingsChange,
  RunSettingsSnapshot,
  RunUsage,
} from "@orbis/api-contract";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { runAgentSegments, runControls, runEvents, type runs } from "../db/schema";
import type { Executor } from "../db/tx";

type RunRow = typeof runs.$inferSelect;
type SegmentRow = typeof runAgentSegments.$inferSelect;

export const RUN_SETTINGS_CHANGED = "run_settings_changed";
export const AGENT_SWITCHED = "agent_switched";

interface SettingsChangedBody {
  control_id: string | null;
  model: string | null;
  effort: Effort | null;
  permission_policy: PermissionPolicy | null;
  not_applied: ("model" | "effort" | "permission_policy")[];
}

interface AgentSwitchedBody {
  from: string;
  to: string;
  model: string | null;
  control_id: string | null;
}

/** `run_settings_changed` 中真正套用的 Permission Policy；沒有改或沒有套用時為 null。 */
function appliedPolicy(body: SettingsChangedBody): PermissionPolicy | null {
  if (body.permission_policy === null || body.not_applied.includes("permission_policy")) {
    return null;
  }
  return body.permission_policy;
}

/**
 * Server 送出的 `set_permission_policy`：control id → 要求的 Permission Policy。只有這些 RunControl 觸發、
 * 而且 Event 的值和要求的相同時才算生效，Runner 自己宣稱的切換不採信（改派、Delegation 會沿用這個值）。
 */
async function requestedPolicies(
  db: Executor,
  runId: string,
): Promise<Map<string, PermissionPolicy>> {
  const rows = await db
    .select({ controlId: runControls.controlId, payload: runControls.payload })
    .from(runControls)
    .where(and(eq(runControls.runId, runId), eq(runControls.action, "set_permission_policy")));
  return new Map(
    rows.map((row) => [row.controlId, (row.payload as { policy: PermissionPolicy }).policy]),
  );
}

/** 這筆 `run_settings_changed` 中真正生效、而且是 Server 要求的 Permission Policy。 */
function trustedPolicy(
  body: SettingsChangedBody,
  requested: Map<string, PermissionPolicy>,
): PermissionPolicy | null {
  const policy = appliedPolicy(body);
  if (policy === null || body.control_id === null) return null;
  return requested.get(body.control_id) === policy ? policy : null;
}

/** 目前的 Permission Policy：最後一筆生效的切換，沒有時是派工時的值。 */
export async function currentPermissionPolicy(
  db: Executor,
  run: Pick<RunRow, "id" | "permissionPolicy">,
): Promise<PermissionPolicy> {
  const rows = await db
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(and(eq(runEvents.runId, run.id), eq(runEvents.kind, RUN_SETTINGS_CHANGED)))
    .orderBy(desc(runEvents.seq));
  if (rows.length === 0) return run.permissionPolicy;
  const requested = await requestedPolicies(db, run.id);
  for (const row of rows) {
    const policy = trustedPolicy(row.payload as SettingsChangedBody, requested);
    if (policy) return policy;
  }
  return run.permissionPolicy;
}

/** Runner 接受 Dispatch 時：還沒有任何分段就以 Run 目前的 Agent 建立第一段。 */
export async function ensureFirstSegment(tx: Executor, run: RunRow, at: Date): Promise<void> {
  await tx
    .insert(runAgentSegments)
    .values({
      runId: run.id,
      position: 1,
      agent: run.agent,
      model: run.model,
      effort: run.effort,
      startedAt: at,
    })
    .onConflictDoNothing();
}

async function openSegment(tx: Executor, run: RunRow, at: Date): Promise<SegmentRow> {
  await ensureFirstSegment(tx, run, at);
  const [open] = await tx
    .select()
    .from(runAgentSegments)
    .where(and(eq(runAgentSegments.runId, run.id), isNull(runAgentSegments.endedAt)));
  if (open) return open;
  // 所有段都已結束（不應該發生）：用最後一段。
  const [last] = await tx
    .select()
    .from(runAgentSegments)
    .where(eq(runAgentSegments.runId, run.id))
    .orderBy(desc(runAgentSegments.position))
    .limit(1);
  if (!last) throw new Error(`Run ${run.id} 沒有分段`);
  return last;
}

const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "thoughtTokens",
  "cachedReadTokens",
  "cachedWriteTokens",
] as const;

/** 各段用量的合計：token 相加（都沒有回報時為 null）；context 取最後一段；費用只合計第一段的幣別。 */
export function sumUsage(usages: Partial<RunUsage>[]): RunUsage {
  const total: RunUsage = {
    inputTokens: null,
    outputTokens: null,
    thoughtTokens: null,
    cachedReadTokens: null,
    cachedWriteTokens: null,
    contextUsedTokens: null,
    contextWindowTokens: null,
    cost: null,
  };
  for (const usage of usages) {
    for (const field of TOKEN_FIELDS) {
      const value = usage[field];
      if (typeof value === "number") total[field] = (total[field] ?? 0) + value;
    }
    const cost = usage.cost;
    if (cost && (total.cost === null || total.cost.currency === cost.currency)) {
      total.cost = { amount: (total.cost?.amount ?? 0) + cost.amount, currency: cost.currency };
    }
  }
  const last = usages.at(-1);
  total.contextUsedTokens = last?.contextUsedTokens ?? null;
  total.contextWindowTokens = last?.contextWindowTokens ?? null;
  return total;
}

/** `usage` Event：寫進目前這一段，回傳所有段的合計（寫回 runs.usage）。 */
export async function recordSegmentUsage(
  tx: Executor,
  run: RunRow,
  usage: RunUsage,
  at: Date,
): Promise<RunUsage> {
  const segment = await openSegment(tx, run, at);
  await tx.update(runAgentSegments).set({ usage }).where(eq(runAgentSegments.id, segment.id));
  const all = await tx
    .select({ usage: runAgentSegments.usage })
    .from(runAgentSegments)
    .where(eq(runAgentSegments.runId, run.id))
    .orderBy(asc(runAgentSegments.position));
  return sumUsage(all.map((s) => s.usage as Partial<RunUsage>));
}

/** `agent_switched`：結束目前這段、開新的一段；回傳要寫回 runs 的欄位。 */
export async function recordAgentSwitched(
  tx: Executor,
  run: RunRow,
  body: AgentSwitchedBody,
  at: Date,
): Promise<Pick<RunRow, "agent" | "model" | "effort">> {
  const segment = await openSegment(tx, run, at);
  await tx.update(runAgentSegments).set({ endedAt: at }).where(eq(runAgentSegments.id, segment.id));
  // 推理強度取自觸發它的 RunControl（Event 沒有帶）。
  let effort: Effort | null = null;
  if (body.control_id) {
    const [control] = await tx
      .select({ payload: runControls.payload })
      .from(runControls)
      .where(eq(runControls.controlId, body.control_id));
    effort = (control?.payload as { effort?: Effort | null } | undefined)?.effort ?? null;
  }
  await tx.insert(runAgentSegments).values({
    runId: run.id,
    position: segment.position + 1,
    agent: body.to,
    model: body.model,
    effort,
    startedAt: at,
  });
  return { agent: body.to, model: body.model, effort };
}

/** `run_settings_changed`：回傳要寫回 runs 的欄位（只有生效的 model、effort）。 */
export function settingsChangedColumns(
  body: SettingsChangedBody,
): Partial<Pick<RunRow, "model" | "effort">> {
  const columns: Partial<Pick<RunRow, "model" | "effort">> = {};
  if (body.model !== null && !body.not_applied.includes("model")) columns.model = body.model;
  if (body.effort !== null && !body.not_applied.includes("effort")) columns.effort = body.effort;
  return columns;
}

/** `GET` runSettings：派工時的設定、目前的設定與每次生效的切換。 */
export async function loadRunSettings(db: Executor, run: RunRow): Promise<RunSettings> {
  const [first] = await db
    .select()
    .from(runAgentSegments)
    .where(eq(runAgentSegments.runId, run.id))
    .orderBy(asc(runAgentSegments.position))
    .limit(1);
  const initial: RunSettingsSnapshot = {
    agent: first?.agent ?? run.agent,
    model: first ? first.model : run.model,
    effort: first ? first.effort : run.effort,
    permissionPolicy: run.permissionPolicy,
  };
  const events = await db
    .select()
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, run.id),
        inArray(runEvents.kind, [RUN_SETTINGS_CHANGED, AGENT_SWITCHED]),
      ),
    )
    .orderBy(asc(runEvents.seq));
  const controlIds = events.flatMap((e) => {
    const id = (e.payload as { control_id?: string | null }).control_id;
    return id ? [id] : [];
  });
  const controls =
    controlIds.length > 0
      ? await db
          .select({
            controlId: runControls.controlId,
            memberId: runControls.requestedByMemberId,
            payload: runControls.payload,
          })
          .from(runControls)
          .where(inArray(runControls.controlId, controlIds))
      : [];
  const byControl = new Map(controls.map((c) => [c.controlId, c]));
  const requested = await requestedPolicies(db, run.id);
  const current: RunSettingsSnapshot = { ...initial };
  const changes: RunSettingsChange[] = [];
  for (const event of events) {
    const control = (() => {
      const id = (event.payload as { control_id?: string | null }).control_id;
      return id ? byControl.get(id) : undefined;
    })();
    const base = {
      seq: event.seq,
      ts: event.ts.toISOString(),
      actorMemberId: control?.memberId ?? null,
    };
    if (event.kind === AGENT_SWITCHED) {
      const body = event.payload as AgentSwitchedBody;
      const effort = (control?.payload as { effort?: Effort | null } | undefined)?.effort ?? null;
      current.agent = body.to;
      current.model = body.model;
      current.effort = effort;
      changes.push({
        ...base,
        agent: body.to,
        model: body.model,
        effort,
        permissionPolicy: null,
        notApplied: [],
      });
      continue;
    }
    const body = event.payload as SettingsChangedBody;
    const columns = settingsChangedColumns(body);
    if (columns.model !== undefined) current.model = columns.model;
    if (columns.effort !== undefined) current.effort = columns.effort;
    const policy = trustedPolicy(body, requested);
    if (policy) current.permissionPolicy = policy;
    changes.push({
      ...base,
      agent: null,
      model: body.model,
      effort: body.effort,
      permissionPolicy: body.permission_policy,
      notApplied: body.not_applied,
    });
  }
  return { initial, current, changes };
}
