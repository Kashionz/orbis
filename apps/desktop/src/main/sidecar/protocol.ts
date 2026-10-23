// Desktop ↔ Runner sidecar 的 stdio 協定（ARCHITECTURE §16），型別與常數定義在 crates/orbis-protocol 的
// sidecar 模組（ts-rs 產生到 @orbis/protocol）：
// - Runner 以 `--sidecar` 啟動時，stdout 每行一個狀態 JSON；log 一律走 stderr。
// - Desktop 透過 stdin 每行送一個指令；stdin EOF 視為 shutdown。
// - 結束碼 SIDECAR_EXIT_NEEDS_PAIRING 表示 Runner token 失效、需要重新 Pairing；
//   SIDECAR_EXIT_VERSION_MISMATCH 表示 Runner 與 Server 的協定版本不相容；其他非 0 視為當掉。
// 這裡只放接收端的容錯解析：協定要求遇到不認得的 `type` 或欄位要忽略，不能因此結束。

import {
  SIDECAR_CONNECTION_STATES,
  type SidecarCommand,
  type SidecarConnectionState,
  type SidecarOutput,
} from "@orbis/protocol";
import { z } from "zod";

export {
  SIDECAR_EXIT_NEEDS_PAIRING,
  SIDECAR_EXIT_VERSION_MISMATCH,
  SIDECAR_FLAG,
  type SidecarCommand,
} from "@orbis/protocol";

/** Runner 回報的狀態（stdout 上 `type: "status"` 的一行）。 */
export type SidecarStatus = SidecarOutput;

/** 容錯解析：未知欄位忽略，未知的 state 視為 offline，型別錯誤的欄位回到預設值。 */
const SidecarStatusLine = z.object({
  type: z.literal("status"),
  state: z
    .string()
    .transform(
      (s): SidecarConnectionState =>
        (SIDECAR_CONNECTION_STATES as readonly string[]).includes(s)
          ? (s as SidecarConnectionState)
          : "offline",
    ),
  runner_id: z.string().nullable().catch(null),
  active_runs: z.number().int().nonnegative().catch(0),
  claiming_paused: z.boolean().catch(false),
}) satisfies z.ZodType<SidecarStatus, unknown>;

/** 解析 stdout 的一行；不是狀態 JSON 的行回傳 null（呼叫端當成一般輸出寫進 log）。 */
export function parseSidecarLine(line: string): SidecarStatus | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = SidecarStatusLine.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function encodeSidecarCommand(command: SidecarCommand): string {
  return `${JSON.stringify(command)}\n`;
}
