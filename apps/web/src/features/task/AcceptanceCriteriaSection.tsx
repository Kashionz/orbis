import {
  ACCEPTANCE_CRITERION_KINDS,
  type AcceptanceCriterion,
  type AcceptanceCriterionKind,
  type UpdateAcceptanceCriterionInput,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  acceptanceCriteriaQuery,
  createAcceptanceCriterion,
  deleteAcceptanceCriterion,
  queryKeys,
  updateAcceptanceCriterion,
} from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { AC_KIND_LABELS, AC_RESULT_LABELS } from "../../lib/labels";

interface Draft {
  kind: AcceptanceCriterionKind;
  description: string;
  /** 只有 `command` 類型使用；空字串表示沿用 Repo 設定檔的 `verify`。 */
  command: string;
}

const EMPTY_DRAFT: Draft = { kind: "command", description: "", command: "" };

function commandOf(draft: Draft): string | null {
  return draft.kind === "command" && draft.command.trim() !== "" ? draft.command.trim() : null;
}

/** Acceptance Criterion 清單：新增、編輯（含類型）、刪除、排序。 */
export function AcceptanceCriteriaSection({
  taskId,
  canEdit,
}: {
  taskId: string;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: criteria = [], error: loadError } = useQuery(acceptanceCriteriaQuery(taskId));
  const [adding, setAdding] = useState<Draft | null>(null);
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.acceptanceCriteria(taskId) });

  const create = useMutation({
    mutationFn: (draft: Draft) =>
      createAcceptanceCriterion(taskId, {
        kind: draft.kind,
        description: draft.description.trim(),
        command: commandOf(draft),
      }),
    onSuccess: () => {
      setAdding(null);
      return invalidate();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAcceptanceCriterionInput }) =>
      updateAcceptanceCriterion(id, input),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: deleteAcceptanceCriterion, onSuccess: invalidate });

  function move(index: number, offset: -1 | 1) {
    const current = criteria[index];
    const other = criteria[index + offset];
    if (!current || !other) return;
    update.mutate({ id: current.id, input: { position: other.position } });
    update.mutate({ id: other.id, input: { position: current.position } });
  }

  return (
    <section className="section" aria-labelledby="ac-heading">
      <div className="section-header">
        <h2 id="ac-heading">Acceptance Criterion</h2>
        {canEdit && adding === null && (
          <button type="button" className="link-button" onClick={() => setAdding(EMPTY_DRAFT)}>
            新增 Acceptance Criterion
          </button>
        )}
      </div>
      <ErrorText error={loadError ?? create.error ?? update.error ?? remove.error} />
      {criteria.length === 0 && <p className="empty">還沒有 Acceptance Criterion</p>}
      <ol className="ac-list">
        {criteria.map((criterion, index) => (
          <CriterionRow
            key={criterion.id}
            criterion={criterion}
            canEdit={canEdit}
            first={index === 0}
            last={index === criteria.length - 1}
            onMove={(offset) => move(index, offset)}
            onDelete={() => remove.mutate(criterion.id)}
            onSave={(input) => update.mutateAsync({ id: criterion.id, input })}
          />
        ))}
      </ol>
      {adding && (
        <CriterionForm
          draft={adding}
          submitLabel="加入"
          busy={create.isPending}
          onChange={setAdding}
          onSubmit={() => create.mutate(adding)}
          onCancel={() => setAdding(null)}
        />
      )}
    </section>
  );
}

interface CriterionRowProps {
  criterion: AcceptanceCriterion;
  canEdit: boolean;
  first: boolean;
  last: boolean;
  onMove: (offset: -1 | 1) => void;
  onDelete: () => void;
  onSave: (input: UpdateAcceptanceCriterionInput) => Promise<unknown>;
}

function CriterionRow({
  criterion,
  canEdit,
  first,
  last,
  onMove,
  onDelete,
  onSave,
}: CriterionRowProps) {
  const [editing, setEditing] = useState<Draft | null>(null);

  if (editing) {
    return (
      <li className="ac-item">
        <CriterionForm
          draft={editing}
          submitLabel="儲存"
          busy={false}
          onChange={setEditing}
          onSubmit={async () => {
            const input: UpdateAcceptanceCriterionInput = {};
            if (editing.kind !== criterion.kind) input.kind = editing.kind;
            if (editing.description.trim() !== criterion.description) {
              input.description = editing.description.trim();
            }
            const command = commandOf(editing);
            // 改成非 command 類型時 command 必須同時設為 null（契約規定）
            if (command !== criterion.command || input.kind !== undefined) input.command = command;
            try {
              if (Object.keys(input).length > 0) await onSave(input);
              setEditing(null);
            } catch {
              // 錯誤訊息由清單上方顯示
            }
          }}
          onCancel={() => setEditing(null)}
        />
      </li>
    );
  }

  return (
    <li className="ac-item" data-kind={criterion.kind}>
      <span className="ac-kind">{criterion.kind}</span>
      <span className="ac-description">{criterion.description}</span>
      {criterion.kind === "command" && (
        <code className="ac-command">{criterion.command ?? "（沿用 Repo 設定的 verify）"}</code>
      )}
      <span className="ac-result" data-result={criterion.result}>
        {AC_RESULT_LABELS[criterion.result]}
      </span>
      {canEdit && (
        <span className="row-actions">
          <button type="button" aria-label="上移" disabled={first} onClick={() => onMove(-1)}>
            ↑
          </button>
          <button type="button" aria-label="下移" disabled={last} onClick={() => onMove(1)}>
            ↓
          </button>
          <button
            type="button"
            onClick={() =>
              setEditing({
                kind: criterion.kind,
                description: criterion.description,
                command: criterion.command ?? "",
              })
            }
          >
            編輯
          </button>
          <button type="button" className="danger" onClick={onDelete}>
            刪除
          </button>
        </span>
      )}
    </li>
  );
}

interface CriterionFormProps {
  draft: Draft;
  submitLabel: string;
  busy: boolean;
  onChange: (draft: Draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function CriterionForm({
  draft,
  submitLabel,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: CriterionFormProps) {
  return (
    <form
      className="ac-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="field-inline">
        類型
        <select
          value={draft.kind}
          onChange={(event) =>
            onChange({ ...draft, kind: event.target.value as AcceptanceCriterionKind })
          }
        >
          {ACCEPTANCE_CRITERION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {AC_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
      <label className="field-inline grow">
        條件
        <input
          value={draft.description}
          required
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
        />
      </label>
      {draft.kind === "command" && (
        <label className="field-inline grow">
          指令
          <input
            value={draft.command}
            placeholder="留空則沿用 Repo 設定的 verify"
            onChange={(event) => onChange({ ...draft, command: event.target.value })}
          />
        </label>
      )}
      <button type="submit" className="primary" disabled={busy || draft.description.trim() === ""}>
        {submitLabel}
      </button>
      <button type="button" onClick={onCancel}>
        取消
      </button>
    </form>
  );
}
