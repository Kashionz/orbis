// 登入狀態。Server 的 `GET /api/auth/me` 回傳 MeResponse；未登入時回 401。

import { z } from "zod";
import { Role } from "./enums";

/** 目前 session 所在 Team 中的 Member；登入者還不是任何 Team 的 Member 時為 null。 */
export const CurrentMember = z.object({
  id: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  role: Role,
  /** GitHub 帳號主要且已驗證的 email；沒有時為 null。 */
  email: z.string().nullable(),
});
export type CurrentMember = z.infer<typeof CurrentMember>;

export const MeResponse = z.object({
  githubUserId: z.number().int(),
  githubLogin: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  member: CurrentMember.nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;
