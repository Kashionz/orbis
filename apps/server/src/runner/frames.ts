// Runner↔Server frame 的執行期驗證。型別來自 @orbis/protocol（Rust 產生），
// 這裡的 zod schema 用 `satisfies` 綁定到產生的型別，協定改動時 typecheck 會失敗。
// `event` frame 的驗證在 runs/event-ingest.ts。

import {
  AGENT_CAPABILITIES,
  DISPATCH_REJECT_REASONS,
  EFFORTS,
  LOGIN_HINT_KINDS,
  MODEL_SOURCES,
  MODEL_TAGS,
  REPO_SPEC_COMMIT_FAILURES,
  RUN_CONTROL_REJECT_REASONS,
  type RunnerToServer,
  TERMINAL_EXIT_REASONS,
  TERMINAL_MAX_CHUNK,
} from "@orbis/protocol";
import { z } from "zod";

type HelloFrame = Extract<RunnerToServer, { type: "hello" }>;
type HeartbeatFrame = Extract<RunnerToServer, { type: "heartbeat" }>;
type AgentAvailabilityFrame = Extract<RunnerToServer, { type: "agent_availability" }>;
type DispatchAcceptFrame = Extract<RunnerToServer, { type: "dispatch_accept" }>;
type DispatchRejectFrame = Extract<RunnerToServer, { type: "dispatch_reject" }>;
type RunControlResultFrame = Extract<RunnerToServer, { type: "run_control_result" }>;

export const HelloFrame = z.object({
  type: z.literal("hello"),
  protocol_version: z.number().int().nonnegative(),
  runner: z.object({
    name: z.string(),
    runner_version: z.string(),
    os: z.string(),
    arch: z.string(),
  }),
  pairing: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pairing_token"), token: z.string() }),
    z.object({ kind: z.literal("runner_token"), runner_id: z.string(), token: z.string() }),
  ]),
}) satisfies z.ZodType<HelloFrame>;

export const HeartbeatFrame = z.object({
  type: z.literal("heartbeat"),
  ts: z.string(),
  active_run_ids: z.array(z.string()),
  // 是否接受新的 Dispatch；派工時要排除 false 的 Runner（B1 實作派工時使用）。
  accepting_dispatches: z.boolean(),
}) satisfies z.ZodType<HeartbeatFrame>;

export const AgentAvailabilityFrame = z.object({
  type: z.literal("agent_availability"),
  agents: z.array(
    z.object({
      id: z.string().min(1),
      version: z.string().nullable(),
      available: z.boolean(),
      unavailable_reason: z.string().nullable(),
      // 能力旗標會增加值；不認得的值直接略過（協定的彈性約定）。
      capabilities: z
        .array(z.string())
        .transform((values) =>
          values.filter((v): v is (typeof AGENT_CAPABILITIES)[number] =>
            (AGENT_CAPABILITIES as readonly string[]).includes(v),
          ),
        ),
      models: z.array(
        z.object({
          id: z.string().min(1),
          name: z.string(),
          tag: z.enum(MODEL_TAGS).nullable(),
          effort: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("adjustable") }),
            z.object({ kind: z.literal("fixed"), level: z.enum(EFFORTS) }),
            z.object({ kind: z.literal("unsupported") }),
          ]),
          source: z.enum(MODEL_SOURCES),
        }),
      ),
      permission_gaps: z.array(z.string()),
      credential: z.string().nullable(),
      display_name: z.string(),
      vendor: z.string().nullable(),
      cli: z.string().nullable(),
      signed_in: z.boolean().nullable(),
      login_hint: z.object({ kind: z.enum(LOGIN_HINT_KINDS), command: z.string() }).nullable(),
    }),
  ),
  credentials: z.array(
    z.object({
      label: z.string(),
      max_concurrent_runs: z.number().int().nonnegative(),
      active_runs: z.number().int().nonnegative(),
    }),
  ),
  mapped_repos: z.array(z.string()),
}) satisfies z.ZodType<AgentAvailabilityFrame, unknown>;

export const DispatchAcceptFrame = z.object({
  type: z.literal("dispatch_accept"),
  dispatch_id: z.string(),
}) satisfies z.ZodType<DispatchAcceptFrame>;

export const DispatchRejectFrame = z.object({
  type: z.literal("dispatch_reject"),
  dispatch_id: z.string(),
  // 未知的理由當作 internal（協定的彈性約定）。
  reason: z
    .string()
    .transform((v) =>
      (DISPATCH_REJECT_REASONS as readonly string[]).includes(v)
        ? (v as (typeof DISPATCH_REJECT_REASONS)[number])
        : "internal",
    ),
  message: z.string(),
}) satisfies z.ZodType<DispatchRejectFrame, unknown>;

const ControlBase = {
  type: z.literal("run_control_result"),
  control_id: z.string(),
  run_id: z.string(),
  dispatch_id: z.string(),
};

export const RunControlResultFrame = z.discriminatedUnion("outcome", [
  z.object({ ...ControlBase, outcome: z.literal("applied") }),
  z.object({
    ...ControlBase,
    outcome: z.literal("branch_pushed"),
    branch: z.string(),
    commit_sha: z.string(),
  }),
  z.object({
    ...ControlBase,
    outcome: z.literal("rejected"),
    reason: z
      .string()
      .transform((v) =>
        (RUN_CONTROL_REJECT_REASONS as readonly string[]).includes(v)
          ? (v as (typeof RUN_CONTROL_REJECT_REASONS)[number])
          : "failed",
      ),
    message: z.string(),
  }),
]) satisfies z.ZodType<RunControlResultFrame, unknown>;

/** base64 解碼後最多 TERMINAL_MAX_CHUNK 位元組（4／3 倍再加 padding）。 */
const TerminalData = z
  .string()
  .max(Math.ceil(TERMINAL_MAX_CHUNK / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

export const TerminalOutputFrame = z.object({
  type: z.literal("terminal_output"),
  terminal_id: z.uuid(),
  data: TerminalData,
}) satisfies z.ZodType<Extract<RunnerToServer, { type: "terminal_output" }>, unknown>;

export const TerminalExitedFrame = z.object({
  type: z.literal("terminal_exited"),
  terminal_id: z.uuid(),
  code: z.number().int().nullable(),
  // 彈性：之後可能增加代碼，不認得的值當成 `exited`。
  reason: z
    .string()
    .transform((v) =>
      (TERMINAL_EXIT_REASONS as readonly string[]).includes(v)
        ? (v as (typeof TERMINAL_EXIT_REASONS)[number])
        : "exited",
    ),
  message: z.string().nullable(),
}) satisfies z.ZodType<Extract<RunnerToServer, { type: "terminal_exited" }>, unknown>;

export const RepoSpecCommitResultFrame = z.discriminatedUnion("outcome", [
  z.object({
    type: z.literal("repo_spec_commit_result"),
    commit_id: z.uuid(),
    outcome: z.literal("committed"),
    commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
  }),
  z.object({
    type: z.literal("repo_spec_commit_result"),
    commit_id: z.uuid(),
    outcome: z.literal("unchanged"),
    commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
  }),
  z.object({
    type: z.literal("repo_spec_commit_result"),
    commit_id: z.uuid(),
    outcome: z.literal("failed"),
    reason: z
      .string()
      .transform((v) =>
        (REPO_SPEC_COMMIT_FAILURES as readonly string[]).includes(v)
          ? (v as (typeof REPO_SPEC_COMMIT_FAILURES)[number])
          : "failed",
      ),
    message: z.string(),
  }),
]) satisfies z.ZodType<Extract<RunnerToServer, { type: "repo_spec_commit_result" }>, unknown>;

/** 只確認是 `{ "type": "..." }` 形式的 JSON 物件；內容由各 frame 的 schema 驗證。 */
const AnyFrame = z.looseObject({ type: z.string() });
export type AnyFrame = z.infer<typeof AnyFrame>;

/** 解析一個 WebSocket 文字訊息；不是合法 frame 時回傳 null。 */
export function parseFrame(data: string): AnyFrame | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const result = AnyFrame.safeParse(json);
  return result.success ? result.data : null;
}
