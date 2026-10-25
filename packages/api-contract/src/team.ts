// Team 與 Member（ARCHITECTURE §4、§12.2）。

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { Role } from "./enums";

export const Team = z.object({
  id: Id,
  name: z.string().min(1),
  /** 是否允許以預覽邀請把 Preview 分享給 Team 以外的人（預設關閉，ADR-0015）。 */
  allowExternalPreview: z.boolean(),
  /** 是否允許在 Team Runner 上開互動式終端機（預設關閉，ADR-0014）。 */
  allowTeamRunnerTerminal: z.boolean(),
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
  /** GitHub 帳號主要且已驗證的 email（每次登入時更新）；沒有或還沒登入過時為 null。 */
  email: z.string().nullable(),
  role: Role,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Member = z.infer<typeof Member>;

/** 修改 Team（`manage_team`，Admin 以上），至少一個欄位。 */
export const UpdateTeamInput = z
  .object({
    name: z.string().trim().min(1),
    allowExternalPreview: z.boolean(),
    allowTeamRunnerTerminal: z.boolean(),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, { error: "至少要更新一個欄位" });
export type UpdateTeamInput = z.input<typeof UpdateTeamInput>;

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
