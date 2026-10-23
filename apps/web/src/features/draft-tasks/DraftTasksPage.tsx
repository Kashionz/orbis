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
import { ErrorText } from "../../components/ErrorText";
import { TextField } from "../../components/TextField";
import { AC_KIND_LABELS } from "../../lib/labels";
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
        <span>Draft Task</span>
      </nav>
      <header className="page-header">
        <h1>Draft Task</h1>
        <span className="spacer" />
        {canEdit && (
          <div className="form-actions">
            <button
              type="button"
              className="primary"
              disabled={selectedCount === 0 || batch.isPending}
              onClick={() => batch.mutate("confirm")}
            >
              確認選取的（{selectedCount}）
            </button>
            <button
              type="button"
              className="danger"
              disabled={selectedCount === 0 || batch.isPending}
              onClick={() => batch.mutate("dismiss")}
            >
              捨棄選取的（{selectedCount}）
            </button>
          </div>
        )}
      </header>
      <p className="hint">
        Agent 提出的 Task，確認後才會進入
        Backlog。依賴同一批的其他草稿（#n）時，要先確認或一起確認被依賴的。
      </p>
      <ErrorText error={error ?? batch.error} />
      {confirmed.length > 0 && (
        <div className="notice-inline" role="status">
          已確認：
          {confirmed.map((task) => (
            <Link key={task.key} to="/tasks/$taskKey" params={{ taskKey: task.key }}>
              {task.key} {task.title}
            </Link>
          ))}
        </div>
      )}
      {drafts.length === 0 && <p className="empty">沒有等待確認的 Draft Task。</p>}
      {groupByBatch(drafts).map(([batchId, list]) => (
        <section key={batchId} className="draft-batch" aria-label={`批次 ${batchId}`}>
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
                全選這一批
              </label>
            )}
            {list[0]?.proposedByRunId && (
              <Link to="/runs/$runId" params={{ runId: list[0].proposedByRunId }}>
                提出的 Run
              </Link>
            )}
            {list[0]?.spec && (
              <span className="hint">
                Spec：<code>{list[0].spec}</code>
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
            aria-label={`選取 ${label}`}
            checked={selected}
            onChange={(event) => onSelect(event.target.checked)}
          />
        )}
        <span className="task-key">#{draft.position}</span>
        <strong>{draft.title}</strong>
        <span className="hint">{repo ? `${repo.owner}/${repo.name}` : "還沒有指定 Repo"}</span>
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
          <ul className="draft-criteria" aria-label="Acceptance Criterion">
            {draft.acceptanceCriteria.map((criterion, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 草稿的條件沒有 id
              <li key={index}>
                <span className="tag">{AC_KIND_LABELS[criterion.kind]}</span>{" "}
                {criterion.description}
                {criterion.command && <code> {criterion.command}</code>}
              </li>
            ))}
          </ul>
          {draft.dependsOn.length > 0 && (
            <p className="draft-depends">
              依賴：
              {draft.dependsOn.map((dep) => (
                <DependencyLabel key={dep} dep={dep} batch={batch} />
              ))}
            </p>
          )}
          {canEdit && (
            <div className="form-actions">
              <button
                type="button"
                className="primary"
                disabled={confirm.isPending}
                onClick={() => confirm.mutate()}
              >
                確認
              </button>
              <button type="button" onClick={() => setEditing(true)}>
                修改
              </button>
              <button
                type="button"
                className="danger"
                disabled={dismiss.isPending}
                onClick={() => dismiss.mutate()}
              >
                捨棄
              </button>
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
  if (dep.startsWith("#")) {
    const target = batch.find((d) => `#${d.position}` === dep);
    return (
      <span className="tag" data-dependency={dep}>
        {dep}
        {target ? ` ${target.title}` : "（已不在這一批）"}
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
      aria-label={`修改 #${draft.position}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField label="標題" value={title} onChange={setTitle} maxLength={200} />
      <TextField label="描述" value={description} onChange={setDescription} multiline />
      <label className="field">
        Repo
        <select value={repoId} onChange={(event) => setRepoId(event.target.value)}>
          <option value="">還沒有指定</option>
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.owner}/{repo.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="draft-criteria-editor">
        <legend>Acceptance Criterion</legend>
        {criteria.map((criterion, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 編輯中的條件沒有 id
          <div key={index} className="draft-criterion-row">
            <select
              aria-label={`第 ${index + 1} 條的類型`}
              value={criterion.kind}
              onChange={(event) =>
                setCriterion(index, { kind: event.target.value as AcceptanceCriterionKind })
              }
            >
              {ACCEPTANCE_CRITERION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {AC_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
            <input
              aria-label={`第 ${index + 1} 條的條件`}
              value={criterion.description}
              onChange={(event) => setCriterion(index, { description: event.target.value })}
            />
            {criterion.kind === "command" && (
              <input
                aria-label={`第 ${index + 1} 條的指令`}
                placeholder="留空：沿用 Repo 設定檔的 verify"
                value={criterion.command}
                onChange={(event) => setCriterion(index, { command: event.target.value })}
              />
            )}
            <button
              type="button"
              className="link-button"
              onClick={() => setCriteria((current) => current.filter((_, i) => i !== index))}
            >
              移除
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
          新增一條
        </button>
      </fieldset>
      <TextField
        label="依賴"
        value={dependsOn}
        onChange={setDependsOn}
        hint="以逗號分隔：同一批的 #n，或既有的 Task Key（例如 ORB-12）。"
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
        <button type="submit" className="primary" disabled={save.isPending}>
          儲存
        </button>
        <button type="button" onClick={() => void onDone(false)}>
          取消
        </button>
      </div>
    </form>
  );
}
