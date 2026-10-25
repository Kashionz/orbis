// Task 分享與 Task 邀請（ADR-0012、ARCHITECTURE §12.2）。

import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz, updatedAt } from "./columns";
import { taskShareRoleEnum } from "./enums";
import { tasks } from "./task";
import { members } from "./team";

/**
 * Task 成員：Task 層級的角色（擁有者、可操作、可檢視）。每個 Task 最多一位擁有者（建立 Task 的人，
 * 可以轉移）。有效權限的計算見 ADR-0012：Owner／Admin 永遠完整；否則取 Task 角色與「一般存取限制後的
 * Team／Project Role」中較高的一個。
 */
export const taskMembers = pgTable(
  "task_members",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    role: taskShareRoleEnum("role").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.memberId] }),
    index("task_members_member_id_idx").on(t.memberId),
    uniqueIndex("task_members_one_owner_per_task").on(t.taskId).where(sql`${t.role} = 'owner'`),
  ],
);

/**
 * 以 email 邀請還不是 Member 的人加入 Task。邀請連結的 token 只存 SHA-256。
 * 接受後以 Viewer 身分加入 Team，再取得 role 的 Task 角色；7 天後過期，可以撤銷。
 */
export const taskInvites = pgTable(
  "task_invites",
  {
    id: id(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** 受邀的 email（小寫）。接受時必須等於登入者已驗證的 email。 */
    email: text("email").notNull(),
    role: taskShareRoleEnum("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamptz("expires_at").notNull(),
    invitedByMemberId: uuid("invited_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    acceptedAt: timestamptz("accepted_at"),
    acceptedByMemberId: uuid("accepted_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamptz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("task_invites_task_id_idx").on(t.taskId),
    check("task_invites_role_not_owner", sql`${t.role} <> 'owner'`),
    check(
      "task_invites_accepted_or_revoked",
      sql`${t.acceptedAt} IS NULL OR ${t.revokedAt} IS NULL`,
    ),
  ],
);
