// Orbis MCP 工具呼叫的處理（ARCHITECTURE §9、ADR-0009）：Runner 把 Agent 的工具呼叫轉成 `tool_call`，
// Server 處理後以 `tool_result` 回覆。
//
// - 每個 call_id 存一筆 orbis_tool_calls。Runner 重新連線後以同一個 call_id 重送：已有結果的直接重送，
//   還在處理的（例如阻塞中的 `wait_run`）不重複處理，Server 重新啟動後沒有結果的重新處理。
// - 只接受呼叫者 Run 目前已接受的 Dispatch；其他一律回 `invalid_state`。
// - Server 只提供列在 handlers 中的工具。Agent 沒有任何工具可以修改 Task 的狀態、指派對象與
//   Acceptance Criterion（§9 的權限限制）：`propose_tasks` 只建立 Draft Task，`update_task_note` 只新增紀錄。
// - 阻塞的工具在背景處理，不會擋住同一條 Runner 連線的其他 frame。

import type {
  OrbisToolErrorCode,
  OrbisToolName,
  OrbisToolOutput,
  OrbisToolResult,
  ServerToRunner,
} from "@orbis/protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { Clock } from "../clock";
import type { Database } from "../db/client";
import { dispatches, orbisToolCalls, projects, runs, tasks } from "../db/schema";
import type { Logger } from "../logger";
import type { RunnerHub } from "../runner/hub";
import { type OrbisToolCallInput, OrbisToolCallSchema, ToolCallEnvelope } from "./frames";
import { RunWatchClosedError } from "./run-watch";

type RunRow = typeof runs.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

/** 工具呼叫失敗，回給 Agent 的錯誤。 */
export class ToolError extends Error {
  constructor(
    readonly code: OrbisToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** 處理一個工具呼叫時的上下文。 */
export interface ToolContext {
  callId: string;
  /** 呼叫工具的 Run。 */
  caller: RunRow;
  task: TaskRow;
  project: ProjectRow;
  /** 呼叫者所在的 Runner。 */
  runnerId: string;
}

export type ToolHandler<T extends OrbisToolName = OrbisToolName> = (
  context: ToolContext,
  call: Extract<OrbisToolCallInput, { tool: T }>,
) => Promise<OrbisToolOutput>;

export type ToolHandlers = { [T in OrbisToolName]?: ToolHandler<T> };

export interface OrbisToolServiceDeps {
  db: Database;
  hub: RunnerHub;
  clock: Clock;
  logger: Logger;
}

export class OrbisToolService {
  private readonly log: Logger;
  private readonly handlers: ToolHandlers = {};
  /** 正在處理中的 call_id（同一個呼叫重送時不重複處理）。 */
  private readonly processing = new Set<string>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: OrbisToolServiceDeps) {
    this.log = deps.logger.child({ component: "orbis-tools" });
  }

  /** 登記工具的處理函式。 */
  register(handlers: ToolHandlers): void {
    Object.assign(this.handlers, handlers);
  }

  /** 收到 `tool_call`。在背景處理，回傳後才完成的工作可以用 idle() 等待。 */
  onToolCall(runnerId: string, frame: unknown): void {
    const job = this.handle(runnerId, frame)
      .catch((error: unknown) => this.log.error({ err: error, runnerId }, "處理工具呼叫失敗"))
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  /** 等目前處理中的工具呼叫都結束（測試與關閉 Server 時用）。 */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async handle(runnerId: string, frame: unknown): Promise<void> {
    const envelope = ToolCallEnvelope.safeParse(frame);
    if (!envelope.success) {
      this.log.warn({ runnerId, issues: envelope.error.issues }, "tool_call 格式不正確，忽略");
      return;
    }
    const { call_id: callId, run_id: runId, dispatch_id: dispatchId } = envelope.data;
    const reply = (result: OrbisToolResult) => this.sendTo(runnerId, callId, runId, result);
    const { db } = this.deps;

    const [existing] = await db
      .select()
      .from(orbisToolCalls)
      .where(eq(orbisToolCalls.callId, callId));
    if (existing && existing.runId !== runId) {
      reply(toolError("invalid_state", "call_id 已被其他 Run 使用"));
      return;
    }
    if (existing?.result) {
      reply(existing.result as OrbisToolResult);
      return;
    }
    if (this.processing.has(callId)) return;

    const context = await this.loadContext(runnerId, runId, dispatchId, callId);
    if (!context) {
      reply(toolError("invalid_state", "這個 Dispatch 不是 Run 目前的 Dispatch"));
      return;
    }
    const call = OrbisToolCallSchema.safeParse(envelope.data.call);
    if (!call.success) {
      reply(toolError("invalid_state", `不支援的工具或參數格式不正確：${envelope.data.call.tool}`));
      return;
    }
    const handler = this.handlers[call.data.tool] as ToolHandler | undefined;
    if (!handler) {
      reply(toolError("invalid_state", `Server 不提供這個工具：${call.data.tool}`));
      return;
    }

    if (!existing) {
      await db
        .insert(orbisToolCalls)
        .values({ callId, runId, tool: call.data.tool, input: call.data })
        .onConflictDoNothing();
    }
    this.processing.add(callId);
    let result: OrbisToolResult;
    try {
      result = { outcome: "ok", output: await handler(context, call.data) };
    } catch (error) {
      // Server 正在關閉：不寫結果也不回覆。Runner 重新連線後以同一個 call_id 重送，再重新處理。
      if (error instanceof RunWatchClosedError) return;
      if (error instanceof ToolError) result = toolError(error.code, error.message);
      else {
        this.log.error({ err: error, callId, tool: call.data.tool }, "工具呼叫處理失敗");
        result = toolError("internal", "Server 處理工具呼叫時發生錯誤");
      }
    } finally {
      this.processing.delete(callId);
    }
    // 有些工具（delegate）在自己的 transaction 中就寫好結果；這裡只補還沒寫的。
    await db
      .update(orbisToolCalls)
      .set({ result, completedAt: this.deps.clock.now() })
      .where(and(eq(orbisToolCalls.callId, callId), isNull(orbisToolCalls.result)));
    const [stored] = await db
      .select({ result: orbisToolCalls.result })
      .from(orbisToolCalls)
      .where(eq(orbisToolCalls.callId, callId));
    await this.deliver(callId, runId, (stored?.result as OrbisToolResult | null) ?? result);
  }

  /** 呼叫者 Run 目前已接受的 Dispatch 屬於這台 Runner 時，回傳上下文。 */
  private async loadContext(
    runnerId: string,
    runId: string,
    dispatchId: string,
    callId: string,
  ): Promise<ToolContext | null> {
    const [row] = await this.deps.db
      .select({ run: runs, task: tasks, project: projects })
      .from(dispatches)
      .innerJoin(runs, eq(runs.id, dispatches.runId))
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(
          eq(dispatches.id, dispatchId),
          eq(dispatches.runId, runId),
          eq(dispatches.runnerId, runnerId),
          eq(dispatches.status, "accepted"),
        ),
      );
    if (!row) return null;
    return { callId, caller: row.run, task: row.task, project: row.project, runnerId };
  }

  /** 把結果送給呼叫者 Run 目前所在的 Runner（處理期間可能已重新連線或改派）。 */
  private async deliver(callId: string, runId: string, result: OrbisToolResult): Promise<void> {
    const [dispatch] = await this.deps.db
      .select({ runnerId: dispatches.runnerId })
      .from(dispatches)
      .where(and(eq(dispatches.runId, runId), eq(dispatches.status, "accepted")));
    if (dispatch) this.sendTo(dispatch.runnerId, callId, runId, result);
  }

  private sendTo(runnerId: string, callId: string, runId: string, result: OrbisToolResult): void {
    const frame: ServerToRunner = { type: "tool_result", call_id: callId, run_id: runId, result };
    this.deps.hub.send(runnerId, frame);
  }
}

export function toolError(code: OrbisToolErrorCode, message: string): OrbisToolResult {
  return { outcome: "error", code, message };
}
