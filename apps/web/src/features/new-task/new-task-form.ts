// 新增任務對話框的表單狀態與計算（純邏輯）。

import type { AcceptanceCriterionKind, READY_REQUIREMENTS, Task } from "@orbis/api-contract";

type ReadyRequirement = (typeof READY_REQUIREMENTS)[number];

export interface CriterionDraft {
  /** 只在表單中用來當 React key。 */
  id: string;
  kind: AcceptanceCriterionKind;
  description: string;
  command: string;
}

export interface NewTaskForm {
  title: string;
  description: string;
  /** null：尚未指定（只有後端支援時才能選）。 */
  repoId: string | null;
  assigneeMemberId: string | null;
  /** 依賴的 Task id；null 表示沒有。 */
  dependsOn: string | null;
  criteria: CriterionDraft[];
}

let draftSeq = 0;

export function newCriterion(kind: AcceptanceCriterionKind): CriterionDraft {
  draftSeq += 1;
  return { id: `draft-${draftSeq}`, kind, description: "", command: "" };
}

/** 有填描述的條件（空白的列不送出）。 */
export function filledCriteria(form: Pick<NewTaskForm, "criteria">): CriterionDraft[] {
  return form.criteria.filter((criterion) => criterion.description.trim() !== "");
}

/** 進入 Ready 還缺少的項目（ARCHITECTURE §5）：Repo、描述、至少一條 Acceptance Criterion。 */
export function missingRequirements(form: NewTaskForm): ReadyRequirement[] {
  const missing: ReadyRequirement[] = [];
  if (!form.repoId) missing.push("repo");
  if (!form.description.trim()) missing.push("description");
  if (filledCriteria(form).length === 0) missing.push("acceptance_criteria");
  return missing;
}

export function canCreate(form: Pick<NewTaskForm, "title">): boolean {
  return form.title.trim() !== "";
}

/**
 * 下一個 Task Key 的預覽（例如 `ORB-43`）：Project 中最大的編號加一。
 * 只是提示，實際的 Key 由 Server 決定。
 */
export function nextTaskKey(keyPrefix: string, tasks: readonly Pick<Task, "key">[]): string {
  let max = 0;
  for (const task of tasks) {
    const match = /-(\d+)$/.exec(task.key);
    if (match && task.key.startsWith(`${keyPrefix}-`)) max = Math.max(max, Number(match[1]));
  }
  return `${keyPrefix}-${max + 1}`;
}
