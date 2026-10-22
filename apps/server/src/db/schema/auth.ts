// 登入 session（ARCHITECTURE §15：GitHub OAuth 登入）。

import { bigint, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz } from "./columns";
import { teams } from "./team";

/**
 * 登入 session：綁定一個 GitHub 身分，並記錄目前所在的 Team。
 * cookie 中是隨機 token，這裡只存它的 SHA-256。GitHub access token 不保存（ADR-0007）。
 * 登入者還不是任何 Team 的 Member 時，current_team_id 為 null。
 */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
    githubLogin: text("github_login").notNull(),
    githubName: text("github_name"),
    githubAvatarUrl: text("github_avatar_url"),
    currentTeamId: uuid("current_team_id").references(() => teams.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (t) => [index("sessions_github_user_id_idx").on(t.githubUserId)],
);
