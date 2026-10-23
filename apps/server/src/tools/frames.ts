// Orbis MCP 工具呼叫（frame `tool_call`）的執行期驗證。型別來自 @orbis/protocol（Rust 產生），
// zod schema 以 `satisfies` 綁定，協定改動時 typecheck 會失敗。

import {
  ACCEPTANCE_CRITERION_KINDS,
  DELEGATION_MODES,
  DELEGATION_PURPOSES,
  PERMISSION_POLICIES,
  type ToolCallFrame,
} from "@orbis/protocol";
import { z } from "zod";

const Uuid = z.uuid();
/** Agent 送來的文字：限制長度，避免一次塞進過大的內容。 */
const Text = (max: number) => z.string().max(max);

const ProposedCriterion = z.object({
  kind: z.enum(ACCEPTANCE_CRITERION_KINDS),
  description: Text(2_000).trim().min(1),
  command: Text(2_000).trim().min(1).nullable(),
});

const ProposedTask = z.object({
  title: Text(200).trim().min(1),
  description: Text(50_000),
  acceptance_criteria: z.array(ProposedCriterion).max(50),
  depends_on: z.array(Text(64)).max(50),
});

export const OrbisToolCallSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("delegate"),
    agent: Text(100).min(1),
    model: Text(200).min(1).nullable(),
    mode: z.enum(DELEGATION_MODES),
    prompt: Text(200_000).min(1),
    permission_policy: z.enum(PERMISSION_POLICIES).nullable(),
    purpose: z.enum(DELEGATION_PURPOSES),
    verification_id: Uuid.nullable(),
  }),
  z.object({ tool: z.literal("get_run"), run_id: Uuid }),
  z.object({
    tool: z.literal("wait_run"),
    run_id: Uuid,
    timeout_ms: z.number().int().nonnegative().nullable(),
  }),
  z.object({ tool: z.literal("list_runs") }),
  z.object({ tool: z.literal("merge_child"), run_id: Uuid }),
  z.object({ tool: z.literal("ask_parent"), question: Text(20_000).trim().min(1) }),
  z.object({
    tool: z.literal("answer_child"),
    run_id: Uuid,
    question_id: Uuid,
    answer: Text(20_000).trim().min(1),
  }),
  z.object({
    tool: z.literal("propose_tasks"),
    spec: Text(50_000).nullable(),
    tasks: z.array(ProposedTask).min(1).max(50),
  }),
  z.object({
    tool: z.literal("update_task_note"),
    task: Text(64).min(1).nullable(),
    note: Text(20_000).trim().min(1),
  }),
]);

/** frame 的外層；`call` 另外驗證，格式不對時仍能回覆錯誤給 Runner。 */
export const ToolCallEnvelope = z.object({
  type: z.literal("tool_call"),
  call_id: Uuid,
  run_id: Uuid,
  dispatch_id: Uuid,
  call: z.looseObject({ tool: z.string() }),
});

export const ToolCallFrameSchema = ToolCallEnvelope.extend({
  call: OrbisToolCallSchema,
}) satisfies z.ZodType<ToolCallFrame & { type: "tool_call" }>;

export type OrbisToolCallInput = z.infer<typeof OrbisToolCallSchema>;
