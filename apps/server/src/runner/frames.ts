// Runner↔Server frame 的執行期驗證。型別來自 @orbis/protocol（Rust 產生），
// 這裡的 zod schema 用 `satisfies` 綁定到產生的型別，協定改動時 typecheck 會失敗。

import type { RunnerToServer } from "@orbis/protocol";
import { z } from "zod";

type HelloFrame = Extract<RunnerToServer, { type: "hello" }>;
type HeartbeatFrame = Extract<RunnerToServer, { type: "heartbeat" }>;

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
