// Task 進入 Ready 的條件（ARCHITECTURE §5）：已指定 Repo、描述不為空或有連結的 Spec、至少一條
// Acceptance Criterion。Server 的狀態機以同樣的條件判斷，不足時回 `missing`；Task 頁先在畫面上列出。

import type { READY_REQUIREMENTS, Task } from "@orbis/api-contract";

export type ReadyRequirement = (typeof READY_REQUIREMENTS)[number];

export interface ReadyCheck {
  requirement: ReadyRequirement;
  met: boolean;
}

/** 依 READY_REQUIREMENTS 的順序列出每一項是否已滿足。 */
export function readyChecklist(
  task: Pick<Task, "repoId" | "description" | "specPath">,
  acceptanceCriterionCount: number,
): ReadyCheck[] {
  return [
    { requirement: "repo", met: task.repoId !== null },
    {
      requirement: "description",
      met: task.description.trim() !== "" || task.specPath !== null,
    },
    { requirement: "acceptance_criteria", met: acceptanceCriterionCount > 0 },
  ];
}

/** 還缺少的項目。 */
export function missingReadyRequirements(checks: readonly ReadyCheck[]): ReadyRequirement[] {
  return checks.filter((c) => !c.met).map((c) => c.requirement);
}
