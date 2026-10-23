// Child Run（ARCHITECTURE §9）：深度與數量限制、Permission Policy 只能收緊、Project 的 Delegation 設定。

import { describe, expect, it } from "vitest";
import {
  checkDelegation,
  type DelegationCheckInput,
  isPolicyAtMostAsPermissive,
  MAX_ACTIVE_CHILD_RUNS,
  MAX_DELEGATION_DEPTH,
} from "../src/runs/delegation-rules";

const base: DelegationCheckInput = {
  project: { delegationEnabled: true, delegationAllowedAgents: null },
  parent: { depth: 0, activeChildren: 0, permissionPolicy: "auto", running: true },
  agent: "codex",
  agentAvailableOnParentRunner: true,
  permissionPolicy: null,
};

const reason = (input: Partial<DelegationCheckInput>) => {
  const result = checkDelegation({ ...base, ...input });
  return result.ok ? "ok" : result.reason;
};

describe("Delegation 的防護規則", () => {
  it("沿用父 Run 的 Permission Policy", () => {
    expect(checkDelegation(base)).toEqual({ ok: true, permissionPolicy: "auto" });
  });

  it(`深度最多 ${MAX_DELEGATION_DEPTH} 層`, () => {
    expect(reason({ parent: { ...base.parent, depth: 1 } })).toBe("ok");
    expect(reason({ parent: { ...base.parent, depth: 2 } })).toBe("depth_limit");
  });

  it(`每個 Run 同時最多 ${MAX_ACTIVE_CHILD_RUNS} 個 Child Run`, () => {
    expect(reason({ parent: { ...base.parent, activeChildren: 4 } })).toBe("ok");
    expect(reason({ parent: { ...base.parent, activeChildren: 5 } })).toBe("child_limit");
  });

  it("Project 關閉 Delegation、或 Agent 不在允許清單時拒絕", () => {
    expect(reason({ project: { delegationEnabled: false, delegationAllowedAgents: null } })).toBe(
      "delegation_disabled",
    );
    expect(
      reason({ project: { delegationEnabled: true, delegationAllowedAgents: ["claude-code"] } }),
    ).toBe("agent_not_allowed");
    expect(
      reason({ project: { delegationEnabled: true, delegationAllowedAgents: ["codex"] } }),
    ).toBe("ok");
  });

  it("父 Run 的 Runner 沒有這個 Agent、或父 Run 已結束時拒絕", () => {
    expect(reason({ agentAvailableOnParentRunner: false })).toBe("agent_unavailable");
    expect(reason({ parent: { ...base.parent, running: false } })).toBe("parent_not_running");
  });

  it("Permission Policy 只能等於或嚴於父 Run", () => {
    expect(reason({ permissionPolicy: "manual" })).toBe("ok");
    expect(reason({ permissionPolicy: "yolo" })).toBe("policy_not_allowed");
    expect(isPolicyAtMostAsPermissive("auto", "yolo")).toBe(true);
    expect(isPolicyAtMostAsPermissive("auto", "manual")).toBe(false);
  });
});
