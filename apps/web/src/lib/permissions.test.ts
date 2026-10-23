import { type ProjectPolicy, ROLES, type Role } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import {
  type Action,
  can,
  canDispatchTo,
  canRespondToPermission,
  defaultPermissionPolicy,
  permissionPoliciesFor,
} from "./permissions";

const policy: ProjectPolicy = {
  planGateEnabled: true,
  delegationEnabled: true,
  delegationAgents: null,
  forbidSelfApproval: false,
  memberCanDispatchToTeamRunner: true,
  defaultPermissionPolicy: "auto",
  autoCreateIssues: false,
  verificationMaxRetries: 3,
  feedbackBotAllowlist: [],
};

/** ARCHITECTURE §12.2 的表格（Project 採預設政策：Member 可以派工到 Team Runner、可以核准自己的 Task）。 */
const MATRIX: Record<Action, Record<Role, boolean>> = {
  "team.manage": { owner: true, admin: true, member: false, viewer: false },
  "project.manage": { owner: true, admin: true, member: false, viewer: false },
  "policy.manage": { owner: true, admin: true, member: false, viewer: false },
  "run.dispatchTeam": { owner: true, admin: true, member: true, viewer: false },
  "task.edit": { owner: true, admin: true, member: true, viewer: false },
  "run.dispatchLocal": { owner: true, admin: true, member: true, viewer: false },
  "run.control": { owner: true, admin: true, member: true, viewer: false },
  "gate.approve": { owner: true, admin: true, member: true, viewer: false },
  "gate.reject": { owner: true, admin: true, member: true, viewer: false },
  view: { owner: true, admin: true, member: true, viewer: true },
};

describe("can：§12.2 每一格", () => {
  for (const [action, row] of Object.entries(MATRIX) as [Action, Record<Role, boolean>][]) {
    for (const role of ROLES) {
      it(`${role} ${row[role] ? "可以" : "不可以"} ${action}`, () => {
        expect(can(action, { role, memberId: "me", policy })).toBe(row[role]);
      });
    }
  }
});

describe("can：Project 政策", () => {
  const closed = { ...policy, memberCanDispatchToTeamRunner: false };

  it("Project 關閉後 Member 不能派工到 Team Runner，Owner／Admin 不受影響", () => {
    expect(can("run.dispatchTeam", { role: "member", memberId: "me", policy: closed })).toBe(false);
    expect(can("run.dispatchTeam", { role: "admin", memberId: "me", policy: closed })).toBe(true);
    expect(can("run.dispatchTeam", { role: "owner", memberId: "me", policy: closed })).toBe(true);
  });

  it("不知道 Project 政策時，Member 不顯示派工到 Team Runner", () => {
    expect(can("run.dispatchTeam", { role: "member", memberId: "me" })).toBe(false);
  });

  it("禁止核准自己的 Task 時，Member 是指派對象就不能核准，但仍可以退回", () => {
    const strict = { ...policy, forbidSelfApproval: true };
    const mine = {
      role: "member" as const,
      memberId: "me",
      policy: strict,
      task: { assigneeMemberId: "me" },
    };
    expect(can("gate.approve", mine)).toBe(false);
    expect(can("gate.reject", mine)).toBe(true);
    expect(can("gate.approve", { ...mine, task: { assigneeMemberId: "someone" } })).toBe(true);
    expect(can("gate.approve", { ...mine, task: { assigneeMemberId: null } })).toBe(true);
  });

  it("禁止核准自己的 Task 只限制 Member，Owner／Admin 仍可以核准（同 Server）", () => {
    const strict = { ...policy, forbidSelfApproval: true };
    for (const role of ["owner", "admin"] as const) {
      const mine = { role, memberId: "me", policy: strict, task: { assigneeMemberId: "me" } };
      expect(can("gate.approve", mine)).toBe(true);
    }
  });

  it("沒有禁止時可以核准自己的 Task", () => {
    expect(
      can("gate.approve", {
        role: "member",
        memberId: "me",
        policy,
        task: { assigneeMemberId: "me" },
      }),
    ).toBe(true);
  });
});

describe("canDispatchTo", () => {
  it("依 Runner 種類對應到不同的操作", () => {
    const ctx = { role: "member" as const, memberId: "me", policy: { ...policy } };
    expect(canDispatchTo("local", ctx)).toBe(true);
    ctx.policy.memberCanDispatchToTeamRunner = false;
    expect(canDispatchTo("team", ctx)).toBe(false);
    expect(canDispatchTo("local", { role: "viewer", memberId: "me", policy })).toBe(false);
  });
});

describe("permissionPoliciesFor", () => {
  it("yolo 只在 Local Runner 提供", () => {
    expect(permissionPoliciesFor("local")).toEqual(["manual", "auto", "yolo"]);
    expect(permissionPoliciesFor("team")).toEqual(["manual", "auto"]);
  });
});

describe("canRespondToPermission", () => {
  const owner = { role: "member" as const, memberId: "me", policy };

  it("Local Runner 上的權限請求只有派工的人能回覆", () => {
    expect(
      canRespondToPermission({ runnerKind: "local", startedByMemberId: "me" }, "tool", owner),
    ).toBe(true);
    expect(
      canRespondToPermission({ runnerKind: "local", startedByMemberId: "someone" }, "tool", owner),
    ).toBe(false);
    expect(
      canRespondToPermission(
        { runnerKind: "local", startedByMemberId: "someone" },
        "agent_settings_changed",
        { ...owner, role: "owner" },
      ),
    ).toBe(false);
  });

  it("Team Runner 上的權限請求，Member 以上都能回覆，Viewer 不行", () => {
    const run = { runnerKind: "team" as const, startedByMemberId: "someone" };
    for (const role of ROLES) {
      expect(canRespondToPermission(run, "tool", { ...owner, role })).toBe(role !== "viewer");
    }
  });

  it("設定的信任核准只有 Admin 以上能回覆，Local Runner 的擁有者是 Member 也不行", () => {
    const mine = { runnerKind: "local" as const, startedByMemberId: "me" };
    const team = { runnerKind: "team" as const, startedByMemberId: "someone" };
    for (const role of ROLES) {
      const allowed = role === "owner" || role === "admin";
      expect(canRespondToPermission(mine, "config_trust", { ...owner, role })).toBe(allowed);
      expect(canRespondToPermission(team, "config_trust", { ...owner, role })).toBe(allowed);
    }
  });
});

describe("defaultPermissionPolicy", () => {
  it("用 Project 的預設政策", () => {
    expect(defaultPermissionPolicy("manual", "local")).toBe("manual");
    expect(defaultPermissionPolicy("manual", "team")).toBe("manual");
    expect(defaultPermissionPolicy("yolo", "local")).toBe("yolo");
  });

  it("Project 預設 yolo 而派到 Team Runner 時改用 auto", () => {
    expect(defaultPermissionPolicy("yolo", "team")).toBe("auto");
  });
});
