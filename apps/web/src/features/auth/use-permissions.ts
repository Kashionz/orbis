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
 * 只能在 AppShell 底下使用：那裡已經確認登入者是 Team 的 Member。
 * `project`、`task` 提供操作所在的 Project（有效 Role 與政策）與 Task。
 * 有 Project 時用它的 `viewerRole`（含 Project 的 Role 覆寫），否則用 Team 的 Role。
 */
export function usePermissions(
  project?: Pick<Project, "policy" | "viewerRole"> | null,
  task?: (Pick<Task, "assigneeMemberId"> & Partial<Pick<Task, "viewerAccess">>) | null,
): Permissions {
  const { data: me } = useSuspenseQuery(meQueryOptions);
  if (!me.member) throw new Error("登入者還不是 Team 的 Member");
  const ctx: PermissionContext = {
    role: project?.viewerRole ?? me.member.role,
    memberId: me.member.id,
    policy: project?.policy,
    task: task ?? undefined,
    // Task 分享（ADR-0012）：Task 上的操作依這個 Task 的有效權限
    ...(task?.viewerAccess && { taskAccess: task.viewerAccess }),
  };
  return { ctx, can: (action) => can(action, ctx) };
}
