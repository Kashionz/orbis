// Task 分享與 Task 邀請（ADR-0012、ARCHITECTURE §12.2）。
//
// - 查看分享：能查看這個 Task 的人。修改分享（成員、角色、轉移擁有者、一般存取、邀請）：Task 的擁有者與
//   Admin 以上（Task 上的有效權限為 `manage`）。
// - 邀請只存 token 的 SHA-256；邀請連結只在建立時回傳一次。email 已經是同一個 Team 某位 Member 的已驗證
//   email 時直接加進 Task，不產生邀請。

import {
  AddTaskShareMembersInput,
  API_ROUTES,
  CreateTaskInviteInput,
  NAMES,
  TASK_INVITE_TTL_DAYS,
  type TaskInviteCreated,
  type TaskInviteRole,
  type TaskShare,
  type TaskShareRole,
  UpdateGeneralAccessInput,
  UpdateTaskShareMemberInput,
} from "@orbis/api-contract";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { loadTaskScope, type TaskScope } from "../authz/scope";
import { randomToken, sha256Hex } from "../crypto";
import { members, taskInvites, taskMembers, tasks } from "../db/schema";
import { type Executor, inTransaction } from "../db/tx";
import { toMember } from "../http/dto";
import { conflict, forbidden, notFound, readId, readJson } from "../http/errors";
import type { AppEnv } from "../http/session";
import type { Services } from "../services";
import { taskInviteUrl } from "./invite-pages";

const DAY_MS = 24 * 60 * 60 * 1000;
const ROLE_RANK: Record<TaskShareRole, number> = { view: 0, edit: 1, owner: 2 };

/** Task 角色中較高的一個（不會把擁有者降級）。 */
export function higherTaskRole(a: TaskShareRole | null, b: TaskShareRole): TaskShareRole {
  if (a === null) return b;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

function requireManage(scope: TaskScope): void {
  if (scope.access !== "manage") {
    throw forbidden("只有 Task 的擁有者與 Admin 以上能管理分享");
  }
}

/** Task 目前的分享：成員（含擁有者）、待接受的邀請、一般存取。 */
export async function loadTaskShare(db: Executor, taskId: string, now: Date): Promise<TaskShare> {
  const [task] = await db
    .select({ generalAccess: tasks.generalAccess })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (!task) throw notFound("Task");
  const memberRows = await db
    .select({ memberId: taskMembers.memberId, role: taskMembers.role })
    .from(taskMembers)
    .where(eq(taskMembers.taskId, taskId))
    .orderBy(asc(taskMembers.createdAt), asc(taskMembers.memberId));
  const invites = await db
    .select()
    .from(taskInvites)
    .where(
      and(
        eq(taskInvites.taskId, taskId),
        isNull(taskInvites.acceptedAt),
        isNull(taskInvites.revokedAt),
        gt(taskInvites.expiresAt, now),
      ),
    )
    .orderBy(asc(taskInvites.createdAt), asc(taskInvites.id));
  return {
    ownerMemberId: memberRows.find((m) => m.role === "owner")?.memberId ?? null,
    members: memberRows,
    invites: invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: invite.role as TaskInviteRole,
      expiresAt: invite.expiresAt.toISOString(),
      invitedByMemberId: invite.invitedByMemberId,
      createdAt: invite.createdAt.toISOString(),
    })),
    generalAccess: task.generalAccess,
  };
}

/** 把同一個 Team 的 Member 設成 Task 成員；擁有者不會被改掉。 */
async function upsertTaskMembers(
  tx: Executor,
  taskId: string,
  memberIds: readonly string[],
  role: TaskInviteRole,
  now: Date,
): Promise<void> {
  const existing = await tx
    .select({ memberId: taskMembers.memberId, role: taskMembers.role })
    .from(taskMembers)
    .where(and(eq(taskMembers.taskId, taskId), inArray(taskMembers.memberId, [...memberIds])));
  const owners = new Set(existing.filter((m) => m.role === "owner").map((m) => m.memberId));
  const targets = memberIds.filter((id) => !owners.has(id));
  if (targets.length === 0) return;
  await tx
    .insert(taskMembers)
    .values(targets.map((memberId) => ({ taskId, memberId, role: role as TaskShareRole })))
    .onConflictDoUpdate({
      target: [taskMembers.taskId, taskMembers.memberId],
      set: { role, updatedAt: now },
    });
}

export function inviteMail(
  taskKey: string,
  taskTitle: string,
  inviterName: string,
  url: string,
): { subject: string; text: string } {
  const product = NAMES.productName;
  return {
    subject: `${product}：${inviterName} 邀請你加入 ${taskKey}／invited you to ${taskKey}`,
    text: [
      `${inviterName} 邀請你加入 ${product} 的任務「${taskKey} ${taskTitle}」。`,
      `請用 GitHub 登入後開啟以下連結（7 天內有效）：`,
      url,
      "",
      `${inviterName} invited you to the ${product} task "${taskKey} ${taskTitle}".`,
      "Sign in with GitHub and open the link above (valid for 7 days).",
    ].join("\n"),
  };
}

export function createTaskShareRoutes(s: Services): Hono<AppEnv> {
  const { db, auth, clock } = s;
  const app = new Hono<AppEnv>();

  app.get(API_ROUTES.taskShare, auth, async (c) => {
    const scope = await loadTaskScope(db, c.get("actor"), readId(c, "taskId", "Task"));
    return c.json(await loadTaskShare(db, scope.task.id, clock.now()));
  });

  app.post(API_ROUTES.taskShareMembers, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireManage(scope);
    const input = await readJson(c, AddTaskShareMembersInput);
    const ids = [...new Set(input.memberIds)];
    await inTransaction(db, async ({ tx }) => {
      const found = await tx
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.teamId, actor.teamId), inArray(members.id, ids)));
      if (found.length !== ids.length) throw notFound("Member");
      await upsertTaskMembers(tx, scope.task.id, ids, input.role, clock.now());
    });
    return c.json(await loadTaskShare(db, scope.task.id, clock.now()));
  });

  /** 改角色；設成 `owner` 是轉移擁有者（原本的擁有者變成可操作）。 */
  app.patch(API_ROUTES.taskShareMember, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireManage(scope);
    const memberId = readId(c, "memberId", "Member");
    const input = await readJson(c, UpdateTaskShareMemberInput);
    const now = clock.now();
    await inTransaction(db, async ({ tx }) => {
      // 鎖住這個 Task 的成員，避免兩個轉移同時進行。
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, scope.task.id))
        .for("update");
      const rows = await tx.select().from(taskMembers).where(eq(taskMembers.taskId, scope.task.id));
      const target = rows.find((m) => m.memberId === memberId);
      if (input.role === "owner") {
        const [member] = await tx
          .select({ id: members.id })
          .from(members)
          .where(and(eq(members.id, memberId), eq(members.teamId, actor.teamId)));
        if (!member) throw notFound("Member");
        if (target?.role === "owner") return;
        await tx
          .update(taskMembers)
          .set({ role: "edit", updatedAt: now })
          .where(and(eq(taskMembers.taskId, scope.task.id), eq(taskMembers.role, "owner")));
        await tx
          .insert(taskMembers)
          .values({ taskId: scope.task.id, memberId, role: "owner" })
          .onConflictDoUpdate({
            target: [taskMembers.taskId, taskMembers.memberId],
            set: { role: "owner", updatedAt: now },
          });
        return;
      }
      if (!target) throw notFound("Task 成員");
      if (target.role === "owner") {
        throw conflict("要改變擁有者的角色，請先把擁有者轉移給別人");
      }
      await tx
        .update(taskMembers)
        .set({ role: input.role, updatedAt: now })
        .where(and(eq(taskMembers.taskId, scope.task.id), eq(taskMembers.memberId, memberId)));
    });
    return c.json(await loadTaskShare(db, scope.task.id, now));
  });

  app.delete(API_ROUTES.taskShareMember, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireManage(scope);
    const memberId = readId(c, "memberId", "Member");
    const [target] = await db
      .select()
      .from(taskMembers)
      .where(and(eq(taskMembers.taskId, scope.task.id), eq(taskMembers.memberId, memberId)));
    if (!target) throw notFound("Task 成員");
    if (target.role === "owner") throw conflict("不能移除擁有者，請先把擁有者轉移給別人");
    await db
      .delete(taskMembers)
      .where(and(eq(taskMembers.taskId, scope.task.id), eq(taskMembers.memberId, memberId)));
    return c.json(await loadTaskShare(db, scope.task.id, clock.now()));
  });

  app.put(API_ROUTES.taskShareGeneral, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireManage(scope);
    const input = await readJson(c, UpdateGeneralAccessInput);
    await db
      .update(tasks)
      .set({ generalAccess: input.generalAccess })
      .where(eq(tasks.id, scope.task.id));
    return c.json(await loadTaskShare(db, scope.task.id, clock.now()));
  });

  /**
   * 以 email 邀請。email 是同一個 Team 某位 Member 的已驗證 email 時直接加進 Task。否則產生邀請：
   * 同一個 Task 對同一個 email 已有有效的邀請時先撤銷，再產生新的（連結只出現一次，遺失時重新邀請）。
   */
  app.post(API_ROUTES.taskShareInvites, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireManage(scope);
    const input = await readJson(c, CreateTaskInviteInput);
    const now = clock.now();
    const [existingMember] = await db
      .select()
      .from(members)
      .where(and(eq(members.teamId, actor.teamId), eq(members.email, input.email)))
      .limit(1);
    if (existingMember) {
      await inTransaction(db, ({ tx }) =>
        upsertTaskMembers(tx, scope.task.id, [existingMember.id], input.role, now),
      );
      return c.json(
        {
          kind: "member_added",
          member: toMember(existingMember),
          role: input.role,
        } satisfies TaskInviteCreated,
        201,
      );
    }

    const token = randomToken();
    const invite = await inTransaction(db, async ({ tx }) => {
      await tx
        .update(taskInvites)
        .set({ revokedAt: now })
        .where(
          and(
            eq(taskInvites.taskId, scope.task.id),
            eq(taskInvites.email, input.email),
            isNull(taskInvites.acceptedAt),
            isNull(taskInvites.revokedAt),
          ),
        );
      const [row] = await tx
        .insert(taskInvites)
        .values({
          taskId: scope.task.id,
          email: input.email,
          role: input.role,
          tokenHash: sha256Hex(token),
          expiresAt: new Date(now.getTime() + TASK_INVITE_TTL_DAYS * DAY_MS),
          invitedByMemberId: actor.memberId,
          createdAt: now,
        })
        .returning();
      if (!row) throw new Error("建立邀請失敗");
      return row;
    });
    const inviteUrl = taskInviteUrl(s.publicUrl, token);
    const [inviter] = await db.select().from(members).where(eq(members.id, actor.memberId));
    const mail = inviteMail(
      scope.task.key,
      scope.task.title,
      inviter?.name ?? inviter?.githubLogin ?? NAMES.productName,
      inviteUrl,
    );
    const emailSent = await s.mailer.send({ to: input.email, ...mail });
    return c.json(
      {
        kind: "invited",
        invite: {
          id: invite.id,
          email: invite.email,
          role: input.role,
          expiresAt: invite.expiresAt.toISOString(),
          invitedByMemberId: invite.invitedByMemberId,
          createdAt: invite.createdAt.toISOString(),
        },
        inviteUrl,
        emailSent,
      } satisfies TaskInviteCreated,
      201,
    );
  });

  app.delete(API_ROUTES.taskShareInvite, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireManage(scope);
    const inviteId = readId(c, "inviteId", "邀請");
    const [invite] = await db
      .select()
      .from(taskInvites)
      .where(and(eq(taskInvites.id, inviteId), eq(taskInvites.taskId, scope.task.id)));
    if (!invite) throw notFound("邀請");
    if (invite.acceptedAt) throw conflict("邀請已經被接受");
    if (invite.revokedAt) throw conflict("邀請已經撤銷");
    await db
      .update(taskInvites)
      .set({ revokedAt: clock.now() })
      .where(eq(taskInvites.id, invite.id));
    return c.json(await loadTaskShare(db, scope.task.id, clock.now()));
  });

  return app;
}
