// Desktop ↔ Runner sidecar 的 stdio 協定（使用者核准的決定 D3）：
// - Runner 以 `--sidecar` 啟動時，stdout 每行一個狀態 JSON；log 一律走 stderr。
// - Desktop 透過 stdin 每行送一個指令；stdin EOF 視為 shutdown。
// - 結束碼 SIDECAR_EXIT_NEEDS_PAIRING 表示 Runner token 失效、需要重新 Pairing，其他非 0 視為當掉。
//
// TODO(contract): 型別定義在 contract/protocol PR 的 crates/orbis-protocol（ts-rs 產生到 @orbis/protocol），
// 合併後改用產生的型別，並刪除這裡的暫時定義。

import { z } from "zod";

/** 啟用 sidecar 模式的旗標。 */
export const SIDECAR_FLAG = "--sidecar";

/** Runner token 失效、需要重新 Pairing 時的結束碼。 */
// TODO(contract): 值待確認（2 與 clap 參數錯誤的結束碼衝突，已提出改用 78）
export const SIDECAR_EXIT_NEEDS_PAIRING = 78;

export const SIDECAR_CONNECTION_STATES = ["connecting", "connected", "offline"] as const;
export type SidecarConnectionState = (typeof SIDECAR_CONNECTION_STATES)[number];

/** Runner 回報的狀態。接收端容錯：未知欄位忽略，未知的 state 視為 offline。 */
export const SidecarStatus = z.object({
  type: z.literal("status"),
  state: z
    .string()
    .transform(
      (s): SidecarConnectionState =>
        (SIDECAR_CONNECTION_STATES as readonly string[]).includes(s)
          ? (s as SidecarConnectionState)
          : "offline",
    ),
  /** Pairing 完成後才有。 */
  runner_id: z.string().nullable().catch(null),
  active_runs: z.number().int().nonnegative().catch(0),
  claiming_paused: z.boolean().catch(false),
});
export type SidecarStatus = z.infer<typeof SidecarStatus>;

export type SidecarCommand =
  | { type: "pause_claiming" }
  | { type: "resume_claiming" }
  | { type: "shutdown" };

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
  const parsed = SidecarStatus.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function encodeSidecarCommand(command: SidecarCommand): string {
  return `${JSON.stringify(command)}\n`;
}
