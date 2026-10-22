// 組織：Team 與 Member（ARCHITECTURE §4、§12.2）。

import { bigint, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./columns";
import { roleEnum } from "./enums";

/** Team：使用 Orbis 的一組成員，擁有共同的 Project、Team Runner 與 Credential 並行上限。 */
export const teams = pgTable("teams", {
  id: id(),
  name: text("name").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Member：Team 中的一個人，以 GitHub 帳號登入。同一個 GitHub 帳號在每個 Team 各有一筆。
 * GitHub 的 login、名稱、頭像是登入時的快照，每次登入都會更新。
 */
export const members = pgTable(
  "members",
  {
    id: id(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
    githubLogin: text("github_login").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    /** Team 層級的 Role；Project 可以用 project_member_roles 覆寫。 */
    role: roleEnum("role").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("members_team_id_github_user_id_unique").on(t.teamId, t.githubUserId),
    index("members_github_user_id_idx").on(t.githubUserId),
  ],
);
