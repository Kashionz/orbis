// 互動式終端機（後端缺口 `terminal`，ADR-0014、ARCHITECTURE §6.5）。
//
// Runner 在 Run 的 Worktree 中開 PTY，輸入輸出經由 Runner 通道到 Server，再經由這裡的 WebSocket
// （`API_ROUTES.terminalWs`）到 Web 的終端機分頁。資料以 base64 傳送。
//
// - 誰能用：Local Runner 只限那台 Runner 的擁有者；Team Runner 只限 Admin 以上，而且 Team 設定
//   `allowTeamRunnerTerminal` 已打開（否則 403 `terminal_disabled`）。其他人 403 `forbidden`。
// - 終端機是人自己下指令，不經過 Permission Policy。Server 只記錄誰在什麼時候開、關，不記錄按鍵與輸出。
// - Worktree 存在期間都能用（Run 結束後也可以）；閒置 30 分鐘自動關閉；每個 Run 最多同時 3 個。
// - WebSocket 關閉即關閉終端機，不支援重新接上。

import {
  TERMINAL_IDLE_TIMEOUT_SECS,
  TERMINAL_MAX_CHUNK,
  TERMINAL_MAX_PER_RUN,
} from "@orbis/protocol";
import { z } from "zod";
import { Id } from "./common";
import { TerminalExitReason } from "./enums";

export { TERMINAL_IDLE_TIMEOUT_SECS, TERMINAL_MAX_CHUNK, TERMINAL_MAX_PER_RUN };

const Cols = z.number().int().min(1).max(500);
const Rows = z.number().int().min(1).max(200);

/** base64（標準字母表、有 padding）。 */
const Base64 = z.base64();

/**
 * `POST` runTerminals：開一個終端機。
 * - Worktree 已封存 → 409 `worktree_archived`；已經開了 `TERMINAL_MAX_PER_RUN` 個 → 409 `terminal_limit`；
 *   Runner 離線 → 409 `runner_offline`。
 */
export const CreateTerminalInput = z.object({ cols: Cols, rows: Rows }).strict();
export type CreateTerminalInput = z.infer<typeof CreateTerminalInput>;

/**
 * `POST` runTerminals 的回應（201）。`wsUrl` 是同源的路徑（`API_ROUTES.terminalWs` 代入 `terminalId`），
 * 以 session cookie 認證、Origin 必須是 Web 的 origin，而且只有開啟的人能連。
 */
export const TerminalCreated = z.object({ terminalId: Id, wsUrl: z.string().startsWith("/") });
export type TerminalCreated = z.infer<typeof TerminalCreated>;

/** 終端機 WebSocket：Web → Server。 */
export const TerminalClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: Base64 }),
  z.object({ type: z.literal("resize"), cols: Cols, rows: Rows }),
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessage>;

export const TERMINAL_WS_ERROR_CODES = ["invalid_message", "not_found", "forbidden"] as const;

/** 終端機 WebSocket：Server → Web。收到 `exited` 後 Server 關閉 WebSocket。 */
export const TerminalServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("output"), data: Base64 }),
  z.object({
    type: z.literal("exited"),
    /** shell 的 exit code；沒有時為 null。 */
    code: z.number().int().nullable(),
    reason: TerminalExitReason,
  }),
  z.object({
    type: z.literal("error"),
    code: z.enum(TERMINAL_WS_ERROR_CODES),
    message: z.string(),
  }),
]);
export type TerminalServerMessage = z.infer<typeof TerminalServerMessage>;
