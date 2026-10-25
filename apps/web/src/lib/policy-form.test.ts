import type { ProjectPolicy } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import { parseList, policyFormValues, validatePolicyForm } from "./policy-form";

const POLICY: ProjectPolicy = {
  planGateEnabled: false,
  delegationEnabled: true,
  delegationAgents: null,
  forbidSelfApproval: false,
  memberCanDispatchToTeamRunner: true,
  defaultPermissionPolicy: "auto",
  autoCreateIssues: true,
  verificationMaxRetries: 3,
  feedbackBotAllowlist: ["coderabbitai[bot]"],
  localMergeStrategy: "squash",
  localPushBase: false,
};

describe("policy-form", () => {
  it("清單以逗號或換行分隔，去掉空白與重複", () => {
    expect(parseList(" claude-code, codex\n\ncodex ,")).toEqual(["claude-code", "codex"]);
  });

  it("沒有修改時轉回原本的政策（不含預設 Permission Policy）", () => {
    const { defaultPermissionPolicy: _policy, ...rest } = POLICY;
    expect(validatePolicyForm(policyFormValues(POLICY))).toEqual({ ok: true, policy: rest });
  });

  it("可以分派的 Agent 留空表示不限制", () => {
    const values = { ...policyFormValues(POLICY), delegationAgents: " " };
    const result = validatePolicyForm(values);
    expect(result.ok && result.policy.delegationAgents).toBeNull();
  });

  it("重試上限超出 1–10 或不是整數時標出欄位", () => {
    for (const value of ["0", "11", "2.5", ""]) {
      const result = validatePolicyForm({
        ...policyFormValues(POLICY),
        verificationMaxRetries: value,
      });
      expect(result).toEqual({
        ok: false,
        errors: { verificationMaxRetries: "重試上限必須是 1–10 的整數" },
      });
    }
  });
});
