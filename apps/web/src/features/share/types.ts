// Task 層級的分享（README State Management：shares per task）的暫定型別與路徑。
//
// TODO(backend, task-sharing)：後端還沒有 Task 層級的成員與角色；這些型別不在 @orbis/api-contract 中，
// 只有 mock 提供。後端完成後移到契約，路徑改用 API_ROUTES。

import { z } from "zod";

/** Task 中的角色：擁有者、可操作（傳訊息、核准權限、審查差異）、可檢視。 */
export const TASK_SHARE_ROLES = ["owner", "edit", "view"] as const;
export const TaskShareRole = z.enum(TASK_SHARE_ROLES);
export type TaskShareRole = z.infer<typeof TaskShareRole>;

/** 邀請時可以給的角色（擁有者不能邀請）。 */
export const InviteRole = z.enum(["edit", "view"]);
export type InviteRole = z.infer<typeof InviteRole>;

/** 一般存取：只有受邀成員、團隊可檢視、團隊可操作。 */
export const GENERAL_ACCESS = ["invited", "team-view", "team-edit"] as const;
export const GeneralAccess = z.enum(GENERAL_ACCESS);
export type GeneralAccess = z.infer<typeof GeneralAccess>;

export const TaskShareMember = z.object({ memberId: z.string(), role: TaskShareRole });
export type TaskShareMember = z.infer<typeof TaskShareMember>;

/** 還不是 Team Member 的人，以 Email 邀請（TODO(backend, task-invites)）。 */
export const TaskShareInvite = z.object({ email: z.email(), role: InviteRole });
export type TaskShareInvite = z.infer<typeof TaskShareInvite>;

export const TaskShare = z.object({
  members: z.array(TaskShareMember),
  invites: z.array(TaskShareInvite),
  general: GeneralAccess,
});
export type TaskShare = z.infer<typeof TaskShare>;

/** 一次加入多位成員與 Email 邀請，給同一個角色。 */
export const AddTaskShareInput = z
  .object({
    memberIds: z.array(z.string()),
    emails: z.array(z.email()),
    role: InviteRole,
  })
  .strict();
export type AddTaskShareInput = z.infer<typeof AddTaskShareInput>;

export const UpdateTaskShareMemberInput = z.object({ role: InviteRole }).strict();
export const UpdateGeneralAccessInput = z.object({ general: GeneralAccess }).strict();

/** 暫定的路徑（參數以 `:name` 表示）。 */
export const SHARE_ROUTES = {
  share: "/api/tasks/:taskId/share",
  shareMembers: "/api/tasks/:taskId/share/members",
  shareMember: "/api/tasks/:taskId/share/members/:memberId",
  shareInvite: "/api/tasks/:taskId/share/invites/:email",
  shareGeneral: "/api/tasks/:taskId/share/general",
} as const;

export function sharePath(path: string, params: Record<string, string>): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ""));
}
