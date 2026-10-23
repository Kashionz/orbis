// Team 與 Member（ARCHITECTURE §4、§12.2）。

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { Role } from "./enums";

export const Team = z.object({
  id: Id,
  name: z.string().min(1),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Team = z.infer<typeof Team>;

/** Team 中的一個人。GitHub login、名稱、頭像是最近一次登入時的快照；比對身分一律用 githubUserId。 */
export const Member = z.object({
  id: Id,
  teamId: Id,
  githubUserId: z.number().int().positive(),
  githubLogin: z.string().min(1),
  name: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  role: Role,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Member = z.infer<typeof Member>;

export const UpdateTeamInput = z.object({ name: z.string().trim().min(1) }).strict();
export type UpdateTeamInput = z.infer<typeof UpdateTeamInput>;

/**
 * Admin 以 GitHub login 新增 Member。Server 先把 login 轉成數字 user id 再保存，
 * 之後一律以 user id 比對（ARCHITECTURE §12.2）。
 */
export const AddMemberInput = z
  .object({ githubLogin: z.string().trim().min(1), role: Role.default("member") })
  .strict();
export type AddMemberInput = z.input<typeof AddMemberInput>;

export const UpdateMemberInput = z.object({ role: Role }).strict();
export type UpdateMemberInput = z.infer<typeof UpdateMemberInput>;
