import type { Role } from "@orbis/api-contract";
import { PERMISSION_PURPOSES } from "@orbis/protocol";
import { describe, expect, it } from "vitest";
import {
  authorize,
  authorizePermissionResponse,
  CAPABILITIES,
  type Capability,
  effectiveRole,
} from "../src/authz/capabilities";

const ME = "member-me";
const OTHER = "member-other";

/** §12.2 的矩陣（加上核准計畫時補充的規則），逐格寫出，不從實作推導。 */
const MATRIX: Record<Capability, Record<Role, boolean>> = {
  view: { owner: true, admin: true, member: true, viewer: true },
  manage_team: { owner: true, admin: true, member: false, viewer: false },
  manage_project: { owner: true, admin: true, member: false, viewer: false },
  manage_permission_policy: { owner: true, admin: true, member: false, viewer: false },
  edit_task: { owner: true, admin: true, member: true, viewer: false },
  dispatch_local: { owner: true, admin: true, member: true, viewer: false },
  dispatch_team: { owner: true, admin: true, member: true, viewer: false },
  approve_gate: { owner: true, admin: true, member: true, viewer: false },
};

const ROLES: Role[] = ["owner", "admin", "member", "viewer"];
const OPEN_POLICY = { allowMemberTeamRunnerDispatch: true, forbidSelfApproval: false };

describe("Role 授權（純函式）", () => {
  it("矩陣涵蓋每一項能力", () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...CAPABILITIES].sort());
  });

  for (const capability of CAPABILITIES) {
    for (const role of ROLES) {
      const expected = MATRIX[capability][role];
      it(`${role} ${expected ? "可以" : "不可以"} ${capability}`, () => {
        const result = authorize(capability, {
          memberId: ME,
          role,
          project: OPEN_POLICY,
          task: { assigneeMemberId: OTHER },
        });
        expect(result.ok).toBe(expected);
      });
    }
  }

  describe("Project 政策：禁止 Member 派工到 Team Runner", () => {
    const policy = { allowMemberTeamRunnerDispatch: false, forbidSelfApproval: false };
    for (const role of ROLES) {
      const expected = role === "owner" || role === "admin";
      it(`${role} ${expected ? "仍可以" : "不可以"}派工到 Team Runner`, () => {
        expect(authorize("dispatch_team", { memberId: ME, role, project: policy }).ok).toBe(
          expected,
        );
      });
    }
    it("不影響派工到自己的 Local Runner", () => {
      expect(
        authorize("dispatch_local", { memberId: ME, role: "member", project: policy }).ok,
      ).toBe(true);
    });
  });

  describe("Project 政策：禁止核准自己的 Task（只看指派對象）", () => {
    const policy = { allowMemberTeamRunnerDispatch: true, forbidSelfApproval: true };
    for (const role of ROLES) {
      const expected = role === "owner" || role === "admin";
      it(`${role} ${expected ? "仍可以" : "不可以"}核准指派給自己的 Task`, () => {
        const result = authorize("approve_gate", {
          memberId: ME,
          role,
          project: policy,
          task: { assigneeMemberId: ME },
        });
        expect(result.ok).toBe(expected);
      });
    }
    it("Member 可以核准指派給別人的 Task", () => {
      const result = authorize("approve_gate", {
        memberId: ME,
        role: "member",
        project: policy,
        task: { assigneeMemberId: OTHER },
      });
      expect(result.ok).toBe(true);
    });
    it("Gate 建立時指派給自己、之後改派給別人，Member 仍不能核准", () => {
      const result = authorize("approve_gate", {
        memberId: ME,
        role: "member",
        project: policy,
        task: { assigneeMemberId: OTHER, gateAssigneeMemberId: ME },
      });
      expect(result.ok).toBe(false);
    });
    it("Member 可以核准沒有指派對象的 Task", () => {
      const result = authorize("approve_gate", {
        memberId: ME,
        role: "member",
        project: policy,
        task: { assigneeMemberId: null },
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("Project 的 Role 覆寫", () => {
    it("沒有覆寫時沿用 Team 的 Role", () => {
      expect(effectiveRole("member", null)).toBe("member");
    });
    it("覆寫可以升級", () => {
      expect(effectiveRole("viewer", "member")).toBe("member");
    });
    it("覆寫可以降級", () => {
      expect(effectiveRole("admin", "viewer")).toBe("viewer");
    });
    it("Team 的 Owner 不受覆寫影響", () => {
      expect(effectiveRole("owner", "viewer")).toBe("owner");
    });
  });

  describe("回覆權限請求", () => {
    /** 逐格寫出：用途 × Runner 種類 × Role ×（是不是 Runner 的擁有者）。 */
    const cases: [string, "local" | "team", Role, boolean, boolean][] = [
      ["tool", "team", "owner", false, true],
      ["tool", "team", "admin", false, true],
      ["tool", "team", "member", false, true],
      ["tool", "team", "viewer", false, false],
      ["tool", "local", "owner", false, false],
      ["tool", "local", "admin", false, false],
      ["tool", "local", "member", true, true],
      ["tool", "local", "viewer", true, false],
      ["config_trust", "team", "admin", false, true],
      ["config_trust", "team", "member", false, false],
      ["config_trust", "local", "owner", false, true],
      ["config_trust", "local", "admin", false, true],
      ["config_trust", "local", "member", true, false],
      ["agent_settings_changed", "team", "member", false, true],
      ["agent_settings_changed", "local", "admin", false, false],
      ["agent_settings_changed", "local", "member", true, true],
    ];
    for (const [purpose, runnerKind, role, isOwner, expected] of cases) {
      it(`${purpose}／${runnerKind}／${role}${isOwner ? "（擁有者）" : ""} → ${expected ? "允許" : "拒絕"}`, () => {
        const result = authorizePermissionResponse({
          memberId: ME,
          role,
          runnerKind,
          runnerOwnerMemberId: runnerKind === "local" ? (isOwner ? ME : OTHER) : null,
          purpose: purpose as (typeof PERMISSION_PURPOSES)[number],
        });
        expect(result.ok).toBe(expected);
      });
    }

    it("涵蓋協定的每一種用途", () => {
      expect([...new Set(cases.map((c) => c[0]))].sort()).toEqual([...PERMISSION_PURPOSES].sort());
    });
  });
});
