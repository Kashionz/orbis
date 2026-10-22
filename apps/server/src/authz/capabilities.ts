// Role 授權（ARCHITECTURE §12.2）。純函式：給定 Role、Project 政策與 Task，判斷能不能做某件事。
// 權限檢查只在 Server 端做；每個 API 在讀到資源後呼叫 authorize()。

import type { Role } from "@orbis/api-contract";

/**
 * 能力。對應 §12.2 的矩陣，以及計畫核准時補充的規則（矩陣沒寫到的操作一律 Admin 以上）。
 * 「核准 config 的信任」與「Credential 的並行上限」目前沒有資料表或協定可以實作，留到 A2／B2。
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
  /** 「自己的 Task」只看指派對象。 */
  task?: { assigneeMemberId: string | null };
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
    input.task?.assigneeMemberId === input.memberId
  ) {
    return { ok: false, reason: "這個 Project 不允許核准指派給自己的 Task" };
  }
  return { ok: true };
}
