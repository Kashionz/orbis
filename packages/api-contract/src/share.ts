// Task 分享與 Task 邀請（後端缺口 `task-sharing`、`task-invites`，ADR-0012、ARCHITECTURE §12.2）。
//
// - Task 角色：擁有者（建立 Task 的人，可以轉移）、可操作、可檢視。「可操作」可以把 Team Viewer 在這個
//   Task 上調高到能編輯、派工、核准關卡、傳訊息。
// - 一般存取：限制其他人在這個 Task 上的權限（僅受邀成員／Team 可檢視／Team 可操作）。
// - Owner、Admin 永遠有完整權限；Admin 層級的能力不受 Task 角色影響。
// - 管理分享：Task 的擁有者、Admin 以上。
// - 以 email 邀請還不是 Member 的人：接受後以 Viewer 身分加入 Team，再取得邀請時選的 Task 角色。

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { GeneralAccess, TaskInviteRole, TaskShareRole } from "./enums";
import { Member } from "./team";

/** Task 邀請的有效期限：7 天。 */
export const TASK_INVITE_TTL_DAYS = 7;

export const TaskShareMember = z.object({ memberId: Id, role: TaskShareRole });
export type TaskShareMember = z.infer<typeof TaskShareMember>;

/** 還沒接受、沒有過期也沒有撤銷的 Task 邀請。 */
export const TaskInvite = z.object({
  id: Id,
  email: z.email(),
  role: TaskInviteRole,
  expiresAt: Timestamp,
  /** 邀請的人；被移除時為 null。 */
  invitedByMemberId: Id.nullable(),
  createdAt: Timestamp,
});
export type TaskInvite = z.infer<typeof TaskInvite>;

/** `GET` taskShare 的回應，也是修改分享的 API 的回應。 */
export const TaskShare = z.object({
  /** Task 的擁有者；沒有時（建立的人已被移除）為 null。 */
  ownerMemberId: Id.nullable(),
  /** Task 成員，含擁有者。 */
  members: z.array(TaskShareMember),
  /** 待接受的邀請。 */
  invites: z.array(TaskInvite),
  generalAccess: GeneralAccess,
});
export type TaskShare = z.infer<typeof TaskShare>;

/** `POST` taskShareMembers：把同一個 Team 的 Member 加進 Task，給同一個角色。已經是成員的人改成這個角色。 */
export const AddTaskShareMembersInput = z
  .object({ memberIds: z.array(Id).min(1).max(50), role: TaskInviteRole })
  .strict();
export type AddTaskShareMembersInput = z.infer<typeof AddTaskShareMembersInput>;

/**
 * `PATCH` taskShareMember：改變成員的角色。設成 `owner` 是轉移擁有者，原本的擁有者變成 `edit`。
 * 不能把擁有者改成其他角色或移除（要先轉移）。
 */
export const UpdateTaskShareMemberInput = z.object({ role: TaskShareRole }).strict();
export type UpdateTaskShareMemberInput = z.infer<typeof UpdateTaskShareMemberInput>;

/** `PUT` taskShareGeneral。 */
export const UpdateGeneralAccessInput = z.object({ generalAccess: GeneralAccess }).strict();
export type UpdateGeneralAccessInput = z.infer<typeof UpdateGeneralAccessInput>;

/**
 * `POST` taskShareInvites：以 email 邀請。email 和某位 Member 的已驗證 email 相同時，直接把那位 Member
 * 加進 Task，不產生邀請。
 */
export const CreateTaskInviteInput = z
  .object({ email: z.string().trim().toLowerCase().pipe(z.email()), role: TaskInviteRole })
  .strict();
export type CreateTaskInviteInput = z.input<typeof CreateTaskInviteInput>;

/**
 * `POST` taskShareInvites 的回應（201）。
 * - `member_added`：已經是 Member，直接加進 Task。
 * - `invited`：產生了邀請。`inviteUrl` 是 Orbis 主網址的 `/invites/<token>`，只在這裡出現一次（Server 只存
 *   hash）；有設定 SMTP 時也寄信（`emailSent`），沒有設定時由邀請人複製連結。
 */
export const TaskInviteCreated = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member_added"), member: Member, role: TaskInviteRole }),
  z.object({
    kind: z.literal("invited"),
    invite: TaskInvite,
    inviteUrl: z.url(),
    emailSent: z.boolean(),
  }),
]);
export type TaskInviteCreated = z.infer<typeof TaskInviteCreated>;

/**
 * 邀請連結 `GET` inviteAccept（瀏覽器導覽，不是 JSON API）：
 * 1. 沒有登入時先以 GitHub 登入，登入後回到這個網址。
 * 2. 登入者已驗證的 email 必須等於受邀的 email，否則顯示 `invite_email_mismatch`。
 * 3. 接受：還不是這個 Team 的 Member 時以 Viewer 身分加入，再取得邀請的 Task 角色，然後轉到 Task 的工作區。
 * 失敗時轉到 Web 的 `/invites/error?code=<代碼>`，代碼是 `INVITE_ERROR_CODES` 之一。
 */
export const INVITE_ERROR_CODES = [
  "invite_not_found",
  "invite_expired",
  "invite_revoked",
  "invite_email_mismatch",
] as const;
export const InviteErrorCode = z.enum(INVITE_ERROR_CODES);
export type InviteErrorCode = z.infer<typeof InviteErrorCode>;
