import {
  ACCEPTANCE_CRITERION_KINDS,
  type AcceptanceCriterionKind,
  type DraftAcceptanceCriterion,
  type DraftTask,
  type Repo,
  UpdateDraftTaskInput,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import Markdown from "react-markdown";
import {
  confirmDraftTask,
  confirmDraftTasks,
  dismissDraftTask,
  dismissDraftTasks,
  draftTasksQuery,
  projectQuery,
  queryKeys,
  reposQuery,
  updateDraftTask,
} from "../../api/resources";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/ErrorText";
import { TextField } from "../../components/TextField";
import { useT } from "../../i18n";
import { repoDisplayName } from "../../lib/github";
import { parseList } from "../../lib/policy-form";
import { usePermissions } from "../auth/use-permissions";

/** 依批次分組，批次內依順序（`#n`）。 */
function groupByBatch(drafts: readonly DraftTask[]): [string, DraftTask[]][] {
  const batches = new Map<string, DraftTask[]>();
  for (const draft of drafts) {
    batches.set(draft.batchId, [...(batches.get(draft.batchId) ?? []), draft]);
  }
  return [...batches].map(([id, list]) => [id, list.sort((a, b) => a.position - b.position)]);
}

/**
 * Draft Task 審核（ARCHITECTURE §9）：Agent 以 `propose_tasks` 提出的 Task，
 * 可以逐筆或批次確認（進入 Backlog）、修改、捨棄。
 */
export function DraftTasksPage({ projectId }: { projectId: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: drafts = [], error } = useQuery(draftTasksQuery(projectId));
  const { data: repos = [] } = useQuery(reposQuery(projectId));
  const permissions = usePermissions(project);
  const canEdit = permissions.can("task.edit");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmed, setConfirmed] = useState<{ title: string; key: string }[]>([]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.draftTasks(projectId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks(projectId) }),
    ]);
  const batch = useMutation({
    mutationFn: async (action: "confirm" | "dismiss") => {
      const ids = drafts.filter((d) => selected.has(d.id)).map((d) => d.id);
      if (action === "dismiss") {
        await dismissDraftTasks(projectId, ids);
        return [];
      }
      const result = await confirmDraftTasks(projectId, ids);
      return result.map(({ task }) => ({ title: task.title, key: task.key }));
    },
    onSuccess: async (tasks) => {
      setSelected(new Set());
      setConfirmed((current) => [...current, ...tasks]);
      await refresh();
    },
  });

  function toggle(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const selectedCount = drafts.filter((d) => selected.has(d.id)).length;

  return (
    <main className="draft-tasks-page">
      <nav className="breadcrumb">
        <Link to="/board" search={{ project: project.id }}>
          {project.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <span>{t.draftTasks.title}</span>
      </nav>
      <header className="page-header">
        <h1>{t.draftTasks.title}</h1>
        <span className="spacer" />
        {canEdit && (
          <div className="form-actions">
            <Button
              variant="primary"
              disabled={selectedCount === 0 || batch.isPending}
              onClick={() => batch.mutate("confirm")}
            >
              {t.draftTasks.confirmSelected(selectedCount)}
            </Button>
            <Button
              variant="danger-ghost"
              disabled={selectedCount === 0 || batch.isPending}
              onClick={() => batch.mutate("dismiss")}
            >
              {t.draftTasks.dismissSelected(selectedCount)}
            </Button>
          </div>
        )}
      </header>
      <p className="hint">{t.draftTasks.intro}</p>
      <ErrorText error={error ?? batch.error} />
      {confirmed.length > 0 && (
        <div className="notice-inline" role="status">
          {t.draftTasks.confirmed}
          {confirmed.map((task) => (
            <Link key={task.key} to="/tasks/$taskKey" params={{ taskKey: task.key }}>
              {task.key} {task.title}
            </Link>
          ))}
        </div>
      )}
      {drafts.length === 0 && <p className="empty">{t.draftTasks.empty}</p>}
      {groupByBatch(drafts).map(([batchId, list]) => (
        <section key={batchId} className="draft-batch" aria-label={t.draftTasks.batch(batchId)}>
          <header className="draft-batch-header">
            {canEdit && (
              <label className="field-inline">
                <input
                  type="checkbox"
                  checked={list.every((d) => selected.has(d.id))}
                  onChange={(event) => {
                    for (const d of list) toggle(d.id, event.target.checked);
                  }}
                />
                {t.draftTasks.selectBatch}
              </label>
            )}
            {list[0]?.proposedByRunId && (
              <Link to="/runs/$runId" params={{ runId: list[0].proposedByRunId }}>
                {t.draftTasks.proposedBy}
              </Link>
            )}
            {list[0]?.spec && (
              <span className="hint">
                {t.draftTasks.spec}
                <code>{list[0].spec}</code>
              </span>
            )}
          </header>
          <ul className="draft-list">
            {list.map((draft) => (
              <DraftTaskItem
                key={draft.id}
                draft={draft}
                batch={list}
                repos={repos}
                canEdit={canEdit}
                selected={selected.has(draft.id)}
                onSelect={(on) => toggle(draft.id, on)}
                onConfirmed={async (task) => {
                  setConfirmed((current) => [...current, task]);
                  await refresh();
                }}
                onChanged={refresh}
              />
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

function DraftTaskItem({
  draft,
  batch,
  repos,
  canEdit,
  selected,
  onSelect,
  onConfirmed,
  onChanged,
}: {
  draft: DraftTask;
  batch: readonly DraftTask[];
  repos: readonly Repo[];
  canEdit: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onConfirmed: (task: { title: string; key: string }) => Promise<unknown>;
  onChanged: () => Promise<unknown>;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const confirm = useMutation({
    mutationFn: () => confirmDraftTask(draft.id),
    onSuccess: (task) => onConfirmed({ title: task.title, key: task.key }),
  });
  const dismiss = useMutation({
    mutationFn: () => dismissDraftTask(draft.id),
    onSuccess: onChanged,
  });
  const repo = repos.find((r) => r.id === draft.repoId);
  const label = `#${draft.position} ${draft.title}`;

  return (
    <li className="draft-task" data-position={draft.position} aria-label={label}>
      <div className="draft-task-header">
        {canEdit && (
          <input
            type="checkbox"
            aria-label={t.draftTasks.select(label)}
            checked={selected}
            onChange={(event) => onSelect(event.target.checked)}
          />
        )}
        <span className="task-key">#{draft.position}</span>
        <strong>{draft.title}</strong>
        <span className="hint">{repo ? repoDisplayName(repo) : t.draftTasks.noRepo}</span>
      </div>
      {editing ? (
        <DraftTaskForm
          draft={draft}
          repos={repos}
          onDone={async (saved) => {
            if (saved) await onChanged();
            setEditing(false);
          }}
        />
      ) : (
        <>
          {draft.description && (
            <div className="markdown">
              <Markdown>{draft.description}</Markdown>
            </div>
          )}
          <ul className="draft-criteria" aria-label={t.draftTasks.acceptanceCriteria}>
            {draft.acceptanceCriteria.map((criterion, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 草稿的條件沒有 id
              <li key={index}>
                <span className="tag">{t.labels.acKind[criterion.kind]}</span>{" "}
                {criterion.description}
                {criterion.command && <code> {criterion.command}</code>}
              </li>
            ))}
          </ul>
          {draft.dependsOn.length > 0 && (
            <p className="draft-depends">
              {t.draftTasks.dependsOnPrefix}
              {draft.dependsOn.map((dep) => (
                <DependencyLabel key={dep} dep={dep} batch={batch} />
              ))}
            </p>
          )}
          {canEdit && (
            <div className="form-actions">
              <Button
                variant="primary"
                disabled={confirm.isPending}
                onClick={() => confirm.mutate()}
              >
                {t.draftTasks.confirm}
              </Button>
              <Button onClick={() => setEditing(true)}>{t.draftTasks.edit}</Button>
              <Button
                variant="danger-ghost"
                disabled={dismiss.isPending}
                onClick={() => dismiss.mutate()}
              >
                {t.draftTasks.dismiss}
              </Button>
            </div>
          )}
          <ErrorText error={confirm.error ?? dismiss.error} />
        </>
      )}
    </li>
  );
}

/** `#n` 顯示同一批草稿的標題；Task Key 連到 Task 頁。 */
function DependencyLabel({ dep, batch }: { dep: string; batch: readonly DraftTask[] }) {
  const t = useT();
  if (dep.startsWith("#")) {
    const target = batch.find((d) => `#${d.position}` === dep);
    return (
      <span className="tag" data-dependency={dep}>
        {dep}
        {target ? ` ${target.title}` : t.draftTasks.notInBatch}
      </span>
    );
  }
  return (
    <Link to="/tasks/$taskKey" params={{ taskKey: dep }} className="tag" data-dependency={dep}>
      {dep}
    </Link>
  );
}

interface CriterionDraft {
  kind: AcceptanceCriterionKind;
  description: string;
  command: string;
}

function DraftTaskForm({
  draft,
  repos,
  onDone,
}: {
  draft: DraftTask;
  repos: readonly Repo[];
  onDone: (saved: boolean) => Promise<unknown>;
}) {
  const t = useT();
  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description);
  const [repoId, setRepoId] = useState(draft.repoId ?? "");
  const [dependsOn, setDependsOn] = useState(draft.dependsOn.join(", "));
  const [criteria, setCriteria] = useState<CriterionDraft[]>(
    draft.acceptanceCriteria.map((c) => ({ ...c, command: c.command ?? "" })),
  );
  const [issues, setIssues] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: (input: UpdateDraftTaskInput) => updateDraftTask(draft.id, input),
    onSuccess: () => onDone(true),
  });

  function submit() {
    const acceptanceCriteria: DraftAcceptanceCriterion[] = criteria.map((c) => ({
      kind: c.kind,
      description: c.description.trim(),
      command: c.kind === "command" && c.command.trim() !== "" ? c.command.trim() : null,
    }));
    const parsed = UpdateDraftTaskInput.safeParse({
      title: title.trim(),
      description,
      repoId: repoId === "" ? null : repoId,
      acceptanceCriteria,
      dependsOn: parseList(dependsOn),
    });
    if (!parsed.success) {
      setIssues(parsed.error.issues.map((issue) => issue.message));
      return;
    }
    setIssues([]);
    save.mutate(parsed.data);
  }

  const setCriterion = (index: number, patch: Partial<CriterionDraft>) =>
    setCriteria((current) => current.map((c, i) => (i === index ? { ...c, ...patch } : c)));

  return (
    <form
      className="settings-form draft-task-form"
      aria-label={t.draftTasks.editForm(draft.position)}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField
        label={t.draftTasks.titleLabel}
        value={title}
        onChange={setTitle}
        maxLength={200}
      />
      <TextField
        label={t.draftTasks.descriptionLabel}
        value={description}
        onChange={setDescription}
        multiline
      />
      <label className="field">
        {t.draftTasks.repo}
        <select value={repoId} onChange={(event) => setRepoId(event.target.value)}>
          <option value="">{t.draftTasks.repoNone}</option>
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repoDisplayName(repo)}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="draft-criteria-editor">
        <legend>{t.draftTasks.acceptanceCriteria}</legend>
        {criteria.map((criterion, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 編輯中的條件沒有 id
          <div key={index} className="draft-criterion-row">
            <select
              aria-label={t.draftTasks.criterionKind(index + 1)}
              value={criterion.kind}
              onChange={(event) =>
                setCriterion(index, { kind: event.target.value as AcceptanceCriterionKind })
              }
            >
              {ACCEPTANCE_CRITERION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t.labels.acKind[kind]}
                </option>
              ))}
            </select>
            <input
              aria-label={t.draftTasks.criterionDescription(index + 1)}
              value={criterion.description}
              onChange={(event) => setCriterion(index, { description: event.target.value })}
            />
            {criterion.kind === "command" && (
              <input
                aria-label={t.draftTasks.criterionCommand(index + 1)}
                placeholder={t.draftTasks.commandPlaceholder}
                value={criterion.command}
                onChange={(event) => setCriterion(index, { command: event.target.value })}
              />
            )}
            <button
              type="button"
              className="link-button"
              onClick={() => setCriteria((current) => current.filter((_, i) => i !== index))}
            >
              {t.common.remove}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="link-button"
          onClick={() =>
            setCriteria((current) => [...current, { kind: "manual", description: "", command: "" }])
          }
        >
          {t.draftTasks.addCriterion}
        </button>
      </fieldset>
      <TextField
        label={t.draftTasks.dependsOn}
        value={dependsOn}
        onChange={setDependsOn}
        hint={t.draftTasks.dependsOnHint}
      />
      {issues.length > 0 && (
        <ul className="error-text" role="alert">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <ErrorText error={save.error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {t.common.save}
        </Button>
        <Button variant="ghost" onClick={() => void onDone(false)}>
          {t.common.cancel}
        </Button>
      </div>
    </form>
  );
}
