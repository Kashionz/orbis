// 依 Role 決定 UI 要不要顯示某個操作（ARCHITECTURE §12.2）。
// 權限檢查以 Server 為準，這裡只負責隱藏沒有權限的操作。

import type {
  PermissionPolicy,
  ProjectPolicy,
  Role,
  Run,
  RunnerKind,
  Task,
  TaskAccess,
} from "@orbis/api-contract";
import type { PermissionPurpose } from "@orbis/protocol";

/** UI 上會依 Role 隱藏的操作。 */
export type Action =
  /** 管理成員、Team Runner、Credential 的並行上限。 */
  | "team.manage"
  /** 建立 Project、修改 Project 的名稱與描述、登記 Repo。 */
  | "project.manage"
  /** 修改 Project 的預設 Permission Policy、核准 config 的信任。 */
  | "policy.manage"
  /** 建立與編輯 Task（含 Acceptance Criterion、depends_on、指派、看板拖曳）。 */
  | "task.edit"
  /** 派工到自己的 Local Runner。 */
  | "run.dispatchLocal"
  /** 派工到 Team Runner。 */
  | "run.dispatchTeam"
  /** 操作進行中的 Run：回覆權限請求、中止。 */
  | "run.control"
  /** 核准 Gate、開 PR。 */
  | "gate.approve"
  /** 退回 Gate（附上行內留言）。 */
  | "gate.reject"
  /** 管理 Task 的分享（成員、角色、一般存取、邀請）：Task 的擁有者與 Admin 以上。 */
  | "task.share"
  /** 查看與留言。 */
  | "view";

export interface PermissionContext {
  /** 目前登入者的有效 Role：在 Project 中用 `Project.viewerRole`（含覆寫），否則用 Team 的 Role。 */
  role: Role;
  /** 目前登入者的 Member ID。 */
  memberId: string;
  /** 操作所在的 Project 的政策；不在任何 Project 中時省略。 */
  policy?: ProjectPolicy;
  /** 操作對象的 Task；與 Task 無關時省略。 */
  task?: Pick<Task, "assigneeMemberId">;
  /** 目前登入者在這個 Task 上的有效權限（`Task.viewerAccess`，ADR-0012）；與 Task 無關時省略。 */
  taskAccess?: TaskAccess;
}

/** 在 Task 上判斷的操作：會受 Task 角色與一般存取影響（ADR-0012）。 */
const TASK_ACTIONS: readonly Action[] = [
  "task.edit",
  "run.dispatchLocal",
  "run.dispatchTeam",
  "run.control",
  "gate.approve",
  "gate.reject",
];

/**
 * Task 上的有效權限換算成判斷操作用的 Role（和 Server 相同）：Owner、Admin 不變；可以操作的人當成 Member
 * （Project 政策照樣套用）；只能看的人當成 Viewer。
 */
export function roleOnTask(role: Role, access: TaskAccess): Role {
  if (role === "owner" || role === "admin") return role;
  return access === "view" ? "viewer" : "member";
}

const EDITORS: readonly Role[] = ["owner", "admin", "member"];
const ADMINS: readonly Role[] = ["owner", "admin"];

export function can(action: Action, ctx: PermissionContext): boolean {
  const role =
    ctx.taskAccess && TASK_ACTIONS.includes(action)
      ? roleOnTask(ctx.role, ctx.taskAccess)
      : ctx.role;
  switch (action) {
    case "task.share":
      return ctx.taskAccess ? ctx.taskAccess === "manage" : ADMINS.includes(role);
    case "view":
      return true;
    case "team.manage":
    case "project.manage":
    case "policy.manage":
      return ADMINS.includes(role);
    case "task.edit":
    case "run.dispatchLocal":
    case "run.control":
    case "gate.reject":
      return EDITORS.includes(role);
    case "run.dispatchTeam":
      if (ADMINS.includes(role)) return true;
      return role === "member" && (ctx.policy?.memberCanDispatchToTeamRunner ?? false);
    case "gate.approve":
      if (!EDITORS.includes(role)) return false;
      // 「禁止核准自己的 Task」只限制 Role 為 Member 的人；「自己的 Task」以指派對象判斷
      return !(
        role === "member" &&
        ctx.policy?.forbidSelfApproval &&
        ctx.task?.assigneeMemberId === ctx.memberId
      );
  }
}

/** 可以派工到這種 Runner 嗎？ */
export function canDispatchTo(runnerKind: RunnerKind, ctx: PermissionContext): boolean {
  return can(runnerKind === "local" ? "run.dispatchLocal" : "run.dispatchTeam", ctx);
}

/**
 * 派工時可以選的 Permission Policy（使用者決定）：能派工的人都可以選 `manual`／`auto`；
 * `yolo` 只在 Local Runner 提供（Team Runner 的 `yolo` 在 Phase 2，§18）。
 */
export function permissionPoliciesFor(runnerKind: RunnerKind): readonly PermissionPolicy[] {
  return runnerKind === "local" ? ["manual", "auto", "yolo"] : ["manual", "auto"];
}

/**
 * 派工對話框的預設 Permission Policy：Project 的預設政策（§8「派工時的選擇」）。
 * 這種 Runner 不提供該政策時（Team Runner 沒有 `yolo`）改用 `auto`。
 */
export function defaultPermissionPolicy(
  projectDefault: PermissionPolicy,
  runnerKind: RunnerKind,
): PermissionPolicy {
  return permissionPoliciesFor(runnerKind).includes(projectDefault) ? projectDefault : "auto";
}

/**
 * 可以回覆這個 Run 的權限請求嗎（§8「誰可以回覆」）：
 * - 設定的信任核准：Admin 以上，不論 Runner 種類。
 * - 其他用途：Local Runner 上的請求只有該 Runner 的擁有者（在自己電腦上派工的人）能回覆；
 *   Team Runner 上的，Role 至少是 Member 的人都能回覆。
 */
/**
 * 能不能做只限 Local Runner 擁有者的操作（和 Server 相同）：換 Permission Policy、換 Agent。Team Runner 上
 * 不限擁有者，依 Project 的規則。
 */
export function isRunnerOwner(
  run: Pick<Run, "runnerKind" | "startedByMemberId">,
  ctx: Pick<PermissionContext, "memberId">,
): boolean {
  return run.runnerKind === "team" || run.startedByMemberId === ctx.memberId;
}

export function canRespondToPermission(
  run: Pick<Run, "runnerKind" | "startedByMemberId">,
  purpose: PermissionPurpose,
  ctx: PermissionContext,
): boolean {
  if (purpose === "config_trust") return can("policy.manage", ctx);
  if (!can("run.control", ctx)) return false;
  return isRunnerOwner(run, ctx);
}
