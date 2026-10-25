// 規格內嵌編輯的草稿（純函式）：Acceptance Criterion 的草稿與存檔時要呼叫的新增、修改、刪除。

import type {
  AcceptanceCriterion,
  AcceptanceCriterionKind,
  CreateAcceptanceCriterionInput,
  UpdateAcceptanceCriterionInput,
} from "@orbis/api-contract";

export interface CriterionDraft {
  /** 既有條件的 id；新增的條件為 null。 */
  id: string | null;
  /** React key（新增的條件也要有）。 */
  key: string;
  kind: AcceptanceCriterionKind;
  description: string;
  /** 只有 `command` 類型使用；空字串表示沿用 Repo 設定檔的 `verify`。 */
  command: string;
}

export function draftsOf(criteria: readonly AcceptanceCriterion[]): CriterionDraft[] {
  return [...criteria]
    .sort((a, b) => a.position - b.position)
    .map((c) => ({
      id: c.id,
      key: c.id,
      kind: c.kind,
      description: c.description,
      command: c.command ?? "",
    }));
}

function commandOf(draft: CriterionDraft): string | null {
  return draft.kind === "command" && draft.command.trim() !== "" ? draft.command.trim() : null;
}

/** 描述是空白的草稿不存（等同刪除）。 */
function kept(drafts: readonly CriterionDraft[]): CriterionDraft[] {
  return drafts.filter((d) => d.description.trim() !== "");
}

export interface CriteriaChanges {
  create: CreateAcceptanceCriterionInput[];
  update: { id: string; input: UpdateAcceptanceCriterionInput }[];
  remove: string[];
}

/** 草稿和原本的條件比較，算出要送出的變更（依草稿的順序決定 position）。 */
export function criteriaChanges(
  original: readonly AcceptanceCriterion[],
  drafts: readonly CriterionDraft[],
): CriteriaChanges {
  const byId = new Map(original.map((c) => [c.id, c]));
  const list = kept(drafts);
  const keptIds = new Set(list.map((d) => d.id).filter((id): id is string => id !== null));
  const changes: CriteriaChanges = {
    create: [],
    update: [],
    remove: original.filter((c) => !keptIds.has(c.id)).map((c) => c.id),
  };
  list.forEach((draft, position) => {
    const command = commandOf(draft);
    const description = draft.description.trim();
    const existing = draft.id ? byId.get(draft.id) : undefined;
    if (!existing) {
      changes.create.push({ kind: draft.kind, description, command, position });
      return;
    }
    const input: UpdateAcceptanceCriterionInput = {};
    if (draft.kind !== existing.kind) input.kind = draft.kind;
    if (description !== existing.description) input.description = description;
    // 改成非 command 類型時 command 必須同時設為 null（契約規定）
    if (command !== existing.command || input.kind !== undefined) input.command = command;
    if (position !== existing.position) input.position = position;
    if (Object.keys(input).length > 0) changes.update.push({ id: existing.id, input });
  });
  return changes;
}

/** 草稿和原本的條件不同（「未儲存」）。 */
export function criteriaDirty(
  original: readonly AcceptanceCriterion[],
  drafts: readonly CriterionDraft[],
): boolean {
  const before = draftsOf(original).map((d) => [d.id, d.kind, d.description, commandOf(d)]);
  const after = drafts.map((d) => [d.id, d.kind, d.description, commandOf(d)]);
  return JSON.stringify(before) !== JSON.stringify(after);
}
