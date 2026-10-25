// 規格的內嵌編輯（README「Task」）：標題、規格（現有的 TipTap／Yjs 共同編輯，即時同步、沒有取消）、
// Acceptance Criterion 的草稿。「未儲存」、取消、儲存、Ctrl+Enter、Esc 只作用在標題與條件（協調者 Q3）。

import type { AcceptanceCriterion, Mention, Project, Task } from "@orbis/api-contract";
import {
  ACCEPTANCE_CRITERION_KINDS,
  type AcceptanceCriterionKind,
  NAMES,
} from "@orbis/api-contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import {
  createAcceptanceCriterion,
  deleteAcceptanceCriterion,
  queryKeys,
  updateAcceptanceCriterion,
  updateTask,
} from "../../../api/resources";
import { ErrorText } from "../../../components/ErrorText";
import { Popover } from "../../../components/Popover";
import { useToast } from "../../../components/Toast";
import { useT } from "../../../i18n";
import { CollabEditor } from "../../collab/CollabEditor";
import { RESULT_GLYPH } from "./AcceptanceList";
import { type CriterionDraft, criteriaChanges, criteriaDirty, draftsOf } from "./spec-draft";

const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

interface SpecEditorProps {
  task: Task;
  project: Project;
  criteria: readonly AcceptanceCriterion[];
  mentions: readonly Mention[];
  onClose: () => void;
}

let draftCounter = 0;

export function SpecEditor({ task, project, criteria, mentions, onClose }: SpecEditorProps) {
  const t = useT();
  const w = t.workspace.task;
  const toast = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(task.title);
  const [drafts, setDrafts] = useState<CriterionDraft[]>(() => draftsOf(criteria));
  const dirty = title.trim() !== task.title || criteriaDirty(criteria, drafts);

  const save = useMutation({
    mutationFn: async () => {
      const changes = criteriaChanges(criteria, drafts);
      for (const id of changes.remove) await deleteAcceptanceCriterion(id);
      for (const { id, input } of changes.update) await updateAcceptanceCriterion(id, input);
      for (const input of changes.create) await createAcceptanceCriterion(task.id, input);
      if (title.trim() !== "" && title.trim() !== task.title) {
        const updated = await updateTask(task.id, { title: title.trim() });
        queryClient.setQueryData(queryKeys.taskByKey(updated.key), updated);
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.acceptanceCriteria(task.id) }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks(project.id) }),
      ]);
    },
    onSuccess: () => {
      toast.show(w.saved);
      onClose();
    },
  });

  function update(key: string, patch: Partial<CriterionDraft>) {
    setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  function move(index: number, delta: number) {
    setDrafts((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      if (item) next.splice(index + delta, 0, item);
      return next;
    });
  }

  function onKeyDown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (!save.isPending) save.mutate();
      return;
    }
    // 選單開著時 Esc 只關選單（Popover 自己處理）
    if (event.key === "Escape" && !document.querySelector(".o-popover")) {
      event.stopPropagation();
      onClose();
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 編輯區的快捷鍵（Ctrl+Enter、Esc）
    <div className="rp-editor" onKeyDown={onKeyDown}>
      <section className="rp-section">
        <div className="rp-editor-head">
          <h2 className="rp-section-title">{w.spec}</h2>
          {dirty && (
            <span className="rp-unsaved">
              <span className="rp-unsaved-dot" />
              {w.unsaved}
            </span>
          )}
          <span className="rp-spacer" />
          <button
            type="button"
            className="o-btn"
            data-variant="ghost"
            data-size="sm"
            onClick={onClose}
          >
            {t.common.cancel}
          </button>
          <button
            type="button"
            className="o-btn"
            data-variant="primary"
            data-size="sm"
            disabled={save.isPending || title.trim() === ""}
            onClick={() => save.mutate()}
          >
            {t.common.save}
          </button>
        </div>
        <input
          className="rp-title-input"
          aria-label={w.title}
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
        />
        <div className="rp-spec-editor">
          <CollabEditor
            docRef={{ kind: "task-description", id: task.id }}
            label={w.spec}
            canEdit
            projectId={project.id}
            mentions={mentions}
            placeholder={w.specPlaceholder}
          />
        </div>
      </section>

      <section className="rp-section">
        <div className="rp-section-head">
          <h2 className="rp-section-title">{w.criteria}</h2>
          <span className="rp-mono-muted">{drafts.filter((d) => d.description.trim()).length}</span>
        </div>
        <div className="rp-draft-list">
          {drafts.map((draft, index) => {
            const original = criteria.find((c) => c.id === draft.id);
            const result = original?.result ?? "pending";
            return (
              <DraftRow
                key={draft.key}
                draft={draft}
                result={result}
                first={index === 0}
                last={index === drafts.length - 1}
                onChange={(patch) => update(draft.key, patch)}
                onMove={(delta) => move(index, delta)}
                onRemove={() => setDrafts((list) => list.filter((d) => d.key !== draft.key))}
              />
            );
          })}
        </div>
        <div>
          <button
            type="button"
            className="o-btn rp-add"
            data-variant="ghost"
            onClick={() => {
              draftCounter += 1;
              setDrafts((list) => [
                ...list,
                {
                  id: null,
                  key: `new-${draftCounter}`,
                  kind: "agent",
                  description: "",
                  command: "",
                },
              ]);
            }}
          >
            <Plus {...ICON} />
            {w.addCriterion}
          </button>
        </div>
        <ErrorText error={save.error} />
      </section>
    </div>
  );
}

function DraftRow({
  draft,
  result,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  draft: CriterionDraft;
  result: AcceptanceCriterion["result"];
  first: boolean;
  last: boolean;
  onChange: (patch: Partial<CriterionDraft>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const w = t.workspace.task;
  const kindRef = useRef<HTMLButtonElement>(null);
  const [kindOpen, setKindOpen] = useState(false);
  return (
    <div className="rp-draft">
      <div className="rp-draft-main">
        <span className="rp-glyph" data-result={result}>
          {RESULT_GLYPH[result]}
        </span>
        <textarea
          className="rp-draft-desc"
          rows={1}
          aria-label={w.criterionPlaceholder}
          placeholder={w.criterionPlaceholder}
          value={draft.description}
          onChange={(event) => onChange({ description: event.target.value })}
        />
        <button
          type="button"
          className="rp-icon-btn"
          aria-label={w.moveUp}
          data-tip={w.moveUp}
          disabled={first}
          onClick={() => onMove(-1)}
        >
          <ArrowUp {...ICON} />
        </button>
        <button
          type="button"
          className="rp-icon-btn"
          aria-label={w.moveDown}
          data-tip={w.moveDown}
          disabled={last}
          onClick={() => onMove(1)}
        >
          <ArrowDown {...ICON} />
        </button>
        <button
          type="button"
          className="rp-icon-btn"
          data-danger="true"
          aria-label={w.remove}
          data-tip={w.remove}
          onClick={onRemove}
        >
          <X {...ICON} />
        </button>
      </div>
      <div className="rp-draft-sub">
        <button
          ref={kindRef}
          type="button"
          className="rp-kind"
          aria-haspopup="menu"
          aria-expanded={kindOpen}
          aria-label={`${w.criterionKind} ${t.labels.acKind[draft.kind]}`}
          onClick={() => setKindOpen((v) => !v)}
        >
          {t.labels.acKind[draft.kind]}
        </button>
        {draft.kind === "command" && (
          <input
            className="rp-command"
            aria-label={w.command}
            placeholder={w.commandPlaceholder}
            value={draft.command}
            onChange={(event) => onChange({ command: event.target.value })}
          />
        )}
        {draft.kind === "command" && draft.command.trim() === "" && (
          // Server 不讀 Repo 的設定檔（只有 Runner 在 base commit 讀），這裡只能提醒
          <p className="rp-warn" role="alert">
            {w.commandEmptyWarning(`${NAMES.configDir}/${NAMES.configFile}`)}
          </p>
        )}
        <Popover<AcceptanceCriterionKind>
          anchorRef={kindRef}
          open={kindOpen}
          onClose={() => setKindOpen(false)}
          label={w.criterionKind}
          prefer="down"
          minWidth={240}
          groups={[
            {
              items: ACCEPTANCE_CRITERION_KINDS.map((kind) => ({
                value: kind,
                label: t.labels.acKind[kind],
                sub: t.labels.acKindDescription[kind],
                mono: true,
                checked: kind === draft.kind,
              })),
            },
          ]}
          onSelect={(kind) => onChange({ kind })}
        />
      </div>
    </div>
  );
}
