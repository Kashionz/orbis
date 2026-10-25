// Role 授權（ARCHITECTURE §12.2）。純函式：給定 Role、Project 政策與 Task，判斷能不能做某件事。
// 權限檢查只在 Server 端做；每個 API 在讀到資源後呼叫 authorize()。

import type {
  GeneralAccess,
  Role,
  RunnerKind,
  TaskAccess,
  TaskShareRole,
} from "@orbis/api-contract";
import type { PermissionPurpose } from "@orbis/protocol";

/**
 * 能力。對應 §12.2 的矩陣，以及計畫核准時補充的規則（矩陣沒寫到的操作一律 Admin 以上）。
 * 「核准 config 的信任」是權限請求的一種（purpose = config_trust），見 authorizePermissionResponse()。
 * 「Credential 的並行上限」目前沒有資料表或協定可以實作，留到 B2。
 */
export const CAPABILITIES = [
  /** 查看與留言。 */
  "view",
  /** 管理成員、Team Runner（Team Runner 的 Pairing token、撤銷他人的 Runner）。Team 層級。 */
  "manage_team",
  /** 建立、修改、刪除 Project，登記 Repo，設定 Project 的 Role 覆寫與政策。 */
  "manage_project",
  /** 修改 Project 預設的 Permission Policy。 */
  "manage_permission_policy",
  /** 建立與編輯 Task 與 Acceptance Criterion、手動轉換狀態、操作 Run（中止、回覆權限請求）。 */
  "edit_task",
  /** 派工到自己的 Local Runner。 */
  "dispatch_local",
  /** 派工到 Team Runner。Project 可以禁止 Role 為 Member 的人使用。 */
  "dispatch_team",
  /** 核准 Gate、開 PR。Project 可以禁止 Role 為 Member 的人核准自己的 Task。 */
  "approve_gate",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** a 的權限是否大於等於 b。 */
export function roleAtLeast(a: Role, b: Role): boolean {
  return ROLE_RANK[a] >= ROLE_RANK[b];
}

/** 每項能力需要的最低 Role（政策造成的額外限制另外處理）。 */
const MINIMUM_ROLE: Record<Capability, Role> = {
  view: "viewer",
  manage_team: "admin",
  manage_project: "admin",
  manage_permission_policy: "admin",
  edit_task: "member",
  dispatch_local: "member",
  dispatch_team: "member",
  approve_gate: "member",
};

/**
 * 在某個 Project 中的有效 Role：有覆寫就用覆寫，否則用 Team 的 Role。
 * Team 層級是 Owner 的人不受覆寫影響；覆寫也不能是 Owner（由寫入端檢查）。
 */
export function effectiveRole(teamRole: Role, projectOverride: Role | null | undefined): Role {
  if (teamRole === "owner") return "owner";
  return projectOverride ?? teamRole;
}

export interface AuthzProjectPolicy {
  /** Role 為 Member 的人能否派工到 Team Runner。 */
  allowMemberTeamRunnerDispatch: boolean;
  /** 是否禁止 Role 為 Member 的人核准自己的 Task。 */
  forbidSelfApproval: boolean;
}

export interface AuthzInput {
  memberId: string;
  /** Team 層級能力用 Team 的 Role；Project 層級能力用 effectiveRole() 的結果。 */
  role: Role;
  project?: AuthzProjectPolicy;
  /**
   * 「自己的 Task」只看指派對象：目前的指派對象，或 Gate 建立時的指派對象，任一個是本人就算。
   * 後者避免在 Gate 等待期間先改派給別人再核准。
   */
  task?: { assigneeMemberId: string | null; gateAssigneeMemberId?: string | null };
}

export type AuthzResult = { ok: true } | { ok: false; reason: string };

export function authorize(capability: Capability, input: AuthzInput): AuthzResult {
  const minimum = MINIMUM_ROLE[capability];
  if (!roleAtLeast(input.role, minimum)) {
    return { ok: false, reason: `需要 ${minimum} 以上的 Role` };
  }
  if (input.role !== "member") return { ok: true };

  if (capability === "dispatch_team" && input.project?.allowMemberTeamRunnerDispatch === false) {
    return { ok: false, reason: "這個 Project 不允許 Role 為 Member 的人派工到 Team Runner" };
  }
  if (
    capability === "approve_gate" &&
    input.project?.forbidSelfApproval === true &&
    (input.task?.assigneeMemberId === input.memberId ||
      input.task?.gateAssigneeMemberId === input.memberId)
  ) {
    return { ok: false, reason: "這個 Project 不允許核准指派給自己的 Task" };
  }
  return { ok: true };
}

/** 在 Task 上判斷的能力（ADR-0012）：會受 Task 角色與一般存取影響。其他能力一律看 Team／Project 的 Role。 */
export const TASK_CAPABILITIES: readonly Capability[] = [
  "view",
  "edit_task",
  "dispatch_local",
  "dispatch_team",
  "approve_gate",
];

const ACCESS_RANK: Record<TaskAccess, number> = { view: 0, edit: 1, manage: 2 };

export interface TaskAccessInput {
  /** 在 Task 所屬 Project 的有效 Role。 */
  role: Role;
  /** 登入者在 Task 上的角色；不是 Task 成員時為 null。 */
  taskRole: TaskShareRole | null;
  generalAccess: GeneralAccess;
}

/**
 * 登入者在某個 Task 上的有效權限（ADR-0012）；看不到這個 Task 時為 null。
 * - Owner、Admin 永遠是 `manage`，不受 Task 分享影響。
 * - 其他人取「Task 角色」與「一般存取限制後的 Role」中較高的一個：一般存取 `team_view` 把 Member 降到只能看，
 *   `invited` 時不是 Task 成員就看不到。
 */
export function taskAccess(input: TaskAccessInput): TaskAccess | null {
  if (roleAtLeast(input.role, "admin")) return "manage";
  const fromRole: TaskAccess = input.role === "member" ? "edit" : "view";
  const limited: TaskAccess | null =
    input.generalAccess === "invited"
      ? null
      : input.generalAccess === "team_view"
        ? "view"
        : fromRole;
  const fromTask: TaskAccess | null =
    input.taskRole === null ? null : input.taskRole === "owner" ? "manage" : input.taskRole;
  if (limited === null) return fromTask;
  if (fromTask === null) return limited;
  return ACCESS_RANK[fromTask] > ACCESS_RANK[limited] ? fromTask : limited;
}

/**
 * Task 上的有效權限換算成判斷 Task 能力時用的 Role：Owner、Admin 不變；可以操作（含擁有者）的人當成 Member
 * （Project 政策照樣套用，例如不能派工到 Team Runner、不能核准自己的 Task）；只能看的人當成 Viewer。
 */
export function roleOnTask(role: Role, access: TaskAccess): Role {
  if (roleAtLeast(role, "admin")) return role;
  return access === "view" ? "viewer" : "member";
}

export interface PermissionResponseAuthzInput {
  memberId: string;
  /** 在 Run 所屬 Project 的有效 Role。 */
  role: Role;
  /** Run 跑在哪一種 Runner。 */
  runnerKind: RunnerKind;
  /** Local Runner 的擁有者；Team Runner 為 null。 */
  runnerOwnerMemberId: string | null;
  purpose: PermissionPurpose;
}

/**
 * 能不能回覆 Agent 的權限請求（ARCHITECTURE §8、§12.2）：
 * - `config_trust`（設定的信任核准）：Admin 以上，不論 Runner 種類。
 * - 其他用途（`tool`、`agent_settings_changed`）：
 *   - Local Runner 上的 Run：只有該 Runner 的擁有者（且仍是 Member 以上）。
 *   - Team Runner 上的 Run：有效 Role 至少是 Member。
 */
export function authorizePermissionResponse(input: PermissionResponseAuthzInput): AuthzResult {
  if (input.purpose === "config_trust") {
    return roleAtLeast(input.role, "admin")
      ? { ok: true }
      : { ok: false, reason: "設定的信任核准需要 admin 以上的 Role" };
  }
  if (!roleAtLeast(input.role, "member")) return { ok: false, reason: "需要 member 以上的 Role" };
  if (input.runnerKind === "local" && input.runnerOwnerMemberId !== input.memberId) {
    return { ok: false, reason: "只有這台 Local Runner 的擁有者能回覆它的權限請求" };
  }
  return { ok: true };
}
