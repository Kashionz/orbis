// Project 政策表單（Plan Gate、Delegation、Verification 重試上限等）與 ProjectPolicy 之間的轉換。
// 規則取自契約的 ProjectPolicy schema；Server 仍會再驗證一次。

import { ProjectPolicy } from "@orbis/api-contract";
import { getMessages } from "../i18n";

/** 表單上的值：清單欄位以文字輸入（逗號或換行分隔）。 */
export interface PolicyFormValues {
  planGateEnabled: boolean;
  verificationMaxRetries: string;
  delegationEnabled: boolean;
  /** 空白表示不限制。 */
  delegationAgents: string;
  forbidSelfApproval: boolean;
  memberCanDispatchToTeamRunner: boolean;
  autoCreateIssues: boolean;
  feedbackBotAllowlist: string;
}

/** 以逗號或換行分隔的清單；去掉空白與重複。 */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function policyFormValues(policy: ProjectPolicy): PolicyFormValues {
  return {
    planGateEnabled: policy.planGateEnabled,
    verificationMaxRetries: String(policy.verificationMaxRetries),
    delegationEnabled: policy.delegationEnabled,
    delegationAgents: policy.delegationAgents?.join(", ") ?? "",
    forbidSelfApproval: policy.forbidSelfApproval,
    memberCanDispatchToTeamRunner: policy.memberCanDispatchToTeamRunner,
    autoCreateIssues: policy.autoCreateIssues,
    feedbackBotAllowlist: policy.feedbackBotAllowlist.join("\n"),
  };
}

/**
 * 這個表單不管的欄位：預設 Permission Policy 另有表單；本機 Repo 的合併設定還沒有 UI
 * （TODO(backend, local-repo)）。送出時省略，Server 保留原本的值。
 */
type OtherPolicyFields = "defaultPermissionPolicy" | "localMergeStrategy" | "localPushBase";

export type PolicyFormResult =
  | { ok: true; policy: Omit<ProjectPolicy, OtherPolicyFields> }
  | { ok: false; errors: Partial<Record<keyof PolicyFormValues, string>> };

/** 驗證並轉成要送出的政策（預設 Permission Policy 另有表單，不在這裡）。 */
export function validatePolicyForm(values: PolicyFormValues): PolicyFormResult {
  const agents = parseList(values.delegationAgents);
  const policy = {
    planGateEnabled: values.planGateEnabled,
    verificationMaxRetries: Number(values.verificationMaxRetries.trim() || Number.NaN),
    delegationEnabled: values.delegationEnabled,
    delegationAgents: agents.length > 0 ? agents : null,
    forbidSelfApproval: values.forbidSelfApproval,
    memberCanDispatchToTeamRunner: values.memberCanDispatchToTeamRunner,
    autoCreateIssues: values.autoCreateIssues,
    feedbackBotAllowlist: parseList(values.feedbackBotAllowlist),
  };
  const result = ProjectPolicy.omit({
    defaultPermissionPolicy: true,
    localMergeStrategy: true,
    localPushBase: true,
  }).safeParse(policy);
  if (result.success) return { ok: true, policy: result.data };
  const errors: Partial<Record<keyof PolicyFormValues, string>> = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "") as keyof PolicyFormValues;
    errors[field] ??=
      field === "verificationMaxRetries" ? getMessages().project.retryLimitInvalid : issue.message;
  }
  return { ok: false, errors };
}
