// 互動式終端機的開關紀錄（ADR-0014）。

import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { id, timestamptz } from "./columns";
import { runs } from "./run";
import { runners } from "./runner";
import { members } from "./team";

/**
 * 互動式終端機的一次開啟：誰在什麼時候開、關。不記錄按鍵與輸出。
 * id 就是協定的 `terminal_id`。closed_at 為 null 表示還開著（每個 Run 最多 3 個，由應用層檢查）。
 */
export const terminalSessions = pgTable(
  "terminal_sessions",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").references(() => members.id, { onDelete: "set null" }),
    /** 開出這個終端機的 Runner。 */
    runnerId: uuid("runner_id").references(() => runners.id, { onDelete: "set null" }),
    openedAt: timestamptz("opened_at").notNull().defaultNow(),
    closedAt: timestamptz("closed_at"),
    /** 協定的 TerminalExitReason；還開著時為 null。 */
    closeReason: text("close_reason"),
  },
  (t) => [
    index("terminal_sessions_run_id_idx").on(t.runId),
    index("terminal_sessions_member_id_idx").on(t.memberId),
  ],
);
