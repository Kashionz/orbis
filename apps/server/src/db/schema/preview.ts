// 預覽邀請（ADR-0015、ARCHITECTURE §13）。

import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz } from "./columns";
import { runs } from "./run";
import { members } from "./team";

/**
 * 預覽邀請：把一個 Run 的 Preview 分享給特定的人（可以是其他 Team 的人或不屬於任何 Team 的人）。
 * 以 GitHub 帳號（github_user_id，登入時以 id 比對）或 email（以 members.email 存下的已驗證 email 比對）
 * 指定，兩者恰好一個。每位受邀者各自一條邀請連結，token 只存 SHA-256。
 * 預覽停止或 Worktree 封存後，這個 Run 的邀請全部失效（由應用層判斷，不改這裡的資料）。
 */
export const previewInvites = pgTable(
  "preview_invites",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    githubUserId: bigint("github_user_id", { mode: "number" }),
    /** 邀請時的 GitHub login（顯示用；比對一律用 github_user_id）。 */
    githubLogin: text("github_login"),
    /** 受邀的 email（小寫）。 */
    email: text("email"),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    revokedAt: timestamptz("revoked_at"),
    lastOpenedAt: timestamptz("last_opened_at"),
  },
  (t) => [
    index("preview_invites_run_id_idx").on(t.runId),
    check("preview_invites_one_invitee", sql`(${t.githubUserId} IS NULL) <> (${t.email} IS NULL)`),
    check(
      "preview_invites_login_with_user_id",
      sql`(${t.githubUserId} IS NULL) = (${t.githubLogin} IS NULL)`,
    ),
  ],
);
