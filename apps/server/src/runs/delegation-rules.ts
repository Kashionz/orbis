// Delegation 的防護規則（ARCHITECTURE §8、§9）：以 Server 為準，Runner 只是先擋一次。
// 純函式：給定父 Run 的狀況與請求，回傳能不能建立 Child Run。

import type { PermissionPolicy } from "@orbis/api-contract";

/** Child Run 的深度上限：頂層 Run 是 0，Child Run 是 1，Child Run 的 Child Run 是 2。 */
export const MAX_DELEGATION_DEPTH = 2;
/** 每個 Run 同時最多幾個還沒結束的 Child Run。 */
export const MAX_ACTIVE_CHILD_RUNS = 5;

/** Permission Policy 由嚴到寬。 */
const POLICY_STRICTNESS: Record<PermissionPolicy, number> = { manual: 0, auto: 1, yolo: 2 };

/** `requested` 是否等於或嚴於 `parent`（Child Run 的權限只能收緊）。 */
export function isPolicyAtMostAsPermissive(
  requested: PermissionPolicy,
  parent: PermissionPolicy,
): boolean {
  return POLICY_STRICTNESS[requested] <= POLICY_STRICTNESS[parent];
}

export type DelegationRejectReason =
  | "delegation_disabled"
  | "agent_not_allowed"
  | "agent_unavailable"
  | "depth_limit"
  | "child_limit"
  | "policy_not_allowed"
  | "parent_not_running";

export interface DelegationCheckInput {
  project: { delegationEnabled: boolean; delegationAllowedAgents: string[] | null };
  parent: {
    /** 父 Run 的深度（頂層 Run 為 0）。 */
    depth: number;
    /** 父 Run 還沒結束的 Child Run 數。 */
    activeChildren: number;
    permissionPolicy: PermissionPolicy;
    /** 父 Run 是否還在執行（已結束的 Run 不能再分派）。 */
    running: boolean;
  };
  /** 要分派的 Agent。 */
  agent: string;
  /** 父 Run 的 Runner 是否回報這個 Agent 可用（Child Run 一律派給父 Run 的 Runner）。 */
  agentAvailableOnParentRunner: boolean;
  /** 請求指定的 Permission Policy；null 表示沿用父 Run。 */
  permissionPolicy: PermissionPolicy | null;
}

export type DelegationCheckResult =
  | { ok: true; permissionPolicy: PermissionPolicy }
  | { ok: false; reason: DelegationRejectReason; message: string };

export function checkDelegation(input: DelegationCheckInput): DelegationCheckResult {
  const { project, parent, agent } = input;
  const reject = (reason: DelegationRejectReason, message: string): DelegationCheckResult => ({
    ok: false,
    reason,
    message,
  });
  if (!parent.running) return reject("parent_not_running", "父 Run 已經結束，不能再分派");
  if (!project.delegationEnabled) {
    return reject("delegation_disabled", "這個 Project 關閉了 Delegation");
  }
  if (
    project.delegationAllowedAgents !== null &&
    !project.delegationAllowedAgents.includes(agent)
  ) {
    return reject("agent_not_allowed", `這個 Project 不允許分派給 ${agent}`);
  }
  if (parent.depth + 1 > MAX_DELEGATION_DEPTH) {
    return reject("depth_limit", `Child Run 最多 ${MAX_DELEGATION_DEPTH} 層`);
  }
  if (parent.activeChildren >= MAX_ACTIVE_CHILD_RUNS) {
    return reject("child_limit", `每個 Run 同時最多 ${MAX_ACTIVE_CHILD_RUNS} 個 Child Run`);
  }
  if (!input.agentAvailableOnParentRunner) {
    return reject("agent_unavailable", `父 Run 的 Runner 上沒有可用的 ${agent}`);
  }
  const policy = input.permissionPolicy ?? parent.permissionPolicy;
  if (!isPolicyAtMostAsPermissive(policy, parent.permissionPolicy)) {
    return reject(
      "policy_not_allowed",
      `Child Run 的 Permission Policy 不能比父 Run（${parent.permissionPolicy}）寬鬆`,
    );
  }
  return { ok: true, permissionPolicy: policy };
}
