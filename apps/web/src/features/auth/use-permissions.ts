// 目前登入者的權限，給各頁面決定要不要顯示操作。

import type { Project, Task } from "@orbis/api-contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import { type Action, can, type PermissionContext } from "../../lib/permissions";
import { meQueryOptions } from "./api";

export interface Permissions {
  ctx: PermissionContext;
  can: (action: Action) => boolean;
}

/**
 * 只能在 AuthedLayout 底下使用：那裡已經確認登入者是 Team 的 Member。
 * `project`、`task` 提供操作所在的 Project 政策與 Task。
 */
export function usePermissions(
  project?: Pick<Project, "policy"> | null,
  task?: Pick<Task, "assigneeMemberId"> | null,
): Permissions {
  const { data: me } = useSuspenseQuery(meQueryOptions);
  if (!me.member) throw new Error("登入者還不是 Team 的 Member");
  const ctx: PermissionContext = {
    role: me.member.role,
    memberId: me.member.id,
    policy: project?.policy,
    task: task ?? undefined,
  };
  return { ctx, can: (action) => can(action, ctx) };
}
