// 組織：Team 與 Member（ARCHITECTURE §4、§12.2）。

import { bigint, boolean, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./columns";
import { roleEnum } from "./enums";

/** Team：使用 Orbis 的一組成員，擁有共同的 Project、Team Runner 與 Credential 並行上限。 */
export const teams = pgTable("teams", {
  id: id(),
  name: text("name").notNull(),
  /** 是否允許以預覽邀請把 Preview 分享給 Team 以外的人（ADR-0015）。 */
  allowExternalPreview: boolean("allow_external_preview").notNull().default(false),
  /** 是否允許在 Team Runner 上開互動式終端機（ADR-0014）。 */
  allowTeamRunnerTerminal: boolean("allow_team_runner_terminal").notNull().default(false),
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
    /**
     * GitHub 帳號主要且已驗證的 email（OAuth 的 `user:email`），每次登入時寫進這個 GitHub 帳號所有的
     * Member 紀錄；沒有已驗證的 email 或還沒登入過時為 null。Task 邀請與預覽邀請以此比對。
     */
    email: text("email"),
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
