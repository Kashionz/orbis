// 新增任務對話框（README §7）：靠上 10vh、680px。標題、描述、儲存庫／指派對象／依賴、驗收條件；
// 底部顯示會進入就緒或待辦（缺少的項目），「建立並開啟」可以用 Ctrl+Enter。

import {
  ACCEPTANCE_CRITERION_KINDS,
  type AcceptanceCriterionKind,
  type Member,
  type Project,
  type Repo,
  type Task,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { GitBranch, GitMerge, Plus, X } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";
import { membersQuery, queryKeys, reposQuery, tasksQuery } from "../../api/resources";
import { Avatar } from "../../components/Avatar";
import { Button, IconButton } from "../../components/Button";
import { ErrorText } from "../../components/ErrorText";
import { hasModifier, shortcutLabel } from "../../components/Kbd";
import { Modal } from "../../components/Modal";
import { Popover, useMenu } from "../../components/Popover";
import { StatusDot } from "../../components/StatusDot";
import { useToast } from "../../components/Toast";
import { useT } from "../../i18n";
import { repoDisplayName } from "../../lib/github";
import { meQueryOptions } from "../auth/api";
import { useShell } from "../shell/shell-context";
import { createTaskFromForm } from "./api";
import {
  type CriterionDraft,
  canCreate,
  filledCriteria,
  missingRequirements,
  type NewTaskForm,
  newCriterion,
  nextTaskKey,
} from "./new-task-form";
import "./new-task.css";

interface NewTaskDialogProps {
  projectId: string | undefined;
  onClose: () => void;
}

export function NewTaskDialog({ projectId, onClose }: NewTaskDialogProps) {
  const t = useT();
  const { projects } = useShell();
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  const titleId = useId();
  return (
    <Modal open onClose={onClose} labelledBy={titleId} placement="top" className="new-task">
      {project ? (
        <NewTaskFormBody key={project.id} project={project} titleId={titleId} onClose={onClose} />
      ) : (
        <div className="new-task-empty">
          <span id={titleId}>{t.newTask.noProject}</span>
        </div>
      )}
    </Modal>
  );
}

function memberName(member: Pick<Member, "name" | "githubLogin">): string {
  return member.githubLogin;
}

function NewTaskFormBody({
  project,
  titleId,
  onClose,
}: {
  project: Project;
  titleId: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const { data: repos = [], isSuccess: reposLoaded } = useQuery(reposQuery(project.id));
  const { data: members = [] } = useQuery(membersQuery);
  const { data: tasks = [] } = useQuery(tasksQuery(project.id));

  const [form, setForm] = useState<NewTaskForm>(() => ({
    title: "",
    description: "",
    repoId: null,
    assigneeMemberId: me.member?.id ?? null,
    dependsOn: null,
    criteria: [newCriterion("command")],
  }));
  // 還沒選過 Repo 時預設第一個（Repo 清單載入後才知道）
  const [repoTouched, setRepoTouched] = useState(false);
  const repoId = repoTouched ? form.repoId : (form.repoId ?? repos[0]?.id ?? null);
  const effective: NewTaskForm = { ...form, repoId };
  const missing = missingRequirements(effective);
  const ready = missing.length === 0;
  const enabled = canCreate(form);

  const update = (patch: Partial<NewTaskForm>) => setForm((current) => ({ ...current, ...patch }));
  const updateCriterion = (id: string, patch: Partial<CriterionDraft>) =>
    setForm((current) => ({
      ...current,
      criteria: current.criteria.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));

  const create = useMutation({
    mutationFn: (_open: boolean) => createTaskFromForm(project.id, effective),
    onSuccess: async ({ task, followUpError }, open) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks(project.id) });
      onClose();
      toast.show(
        followUpError
          ? `${t.newTask.created(task.key)}：${followUpError instanceof Error ? followUpError.message : String(followUpError)}`
          : t.newTask.created(task.key),
      );
      if (open || followUpError) {
        await navigate({ to: "/tasks/$taskKey", params: { taskKey: task.key } });
      }
    },
  });

  function submit(open: boolean) {
    if (!enabled || create.isPending) return;
    create.mutate(open);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" && hasModifier(event)) {
      event.preventDefault();
      submit(true);
    }
  }

  const repo = repos.find((r) => r.id === repoId);
  const assignee = members.find((m) => m.id === form.assigneeMemberId);
  const dependency = tasks.find((task) => task.id === form.dependsOn);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Ctrl+Enter 是整個表單的快捷鍵
    <div className="new-task-panel" onKeyDown={onKeyDown}>
      <div className="new-task-header">
        <h2 id={titleId} className="new-task-heading">
          {t.newTask.title}
        </h2>
        <span className="new-task-key">{nextTaskKey(project.keyPrefix, tasks)}</span>
        <span className="o-dialog-spacer" />
        <IconButton label={t.common.close} icon={<X size={16} />} onClick={onClose} />
      </div>

      <div className="new-task-body">
        <input
          className="new-task-title"
          value={form.title}
          placeholder={t.newTask.titlePlaceholder}
          aria-label={t.newTask.titlePlaceholder}
          maxLength={200}
          // biome-ignore lint/a11y/noAutofocus: 對話框打開時直接輸入標題
          autoFocus
          onChange={(event) => update({ title: event.target.value })}
        />
        <textarea
          className="new-task-description"
          value={form.description}
          rows={4}
          placeholder={t.newTask.descriptionPlaceholder}
          aria-label={t.newTask.descriptionPlaceholder}
          onChange={(event) => update({ description: event.target.value })}
        />
        <div className="new-task-chips">
          <RepoChip
            repos={repos}
            repo={repo ?? null}
            onChange={(id) => {
              setRepoTouched(true);
              update({ repoId: id });
            }}
          />
          <AssigneeChip
            members={members}
            assignee={assignee ?? null}
            onChange={(id) => update({ assigneeMemberId: id })}
          />
          <DependsChip
            tasks={tasks}
            dependency={dependency ?? null}
            onChange={(id) => update({ dependsOn: id })}
          />
        </div>
        {reposLoaded && repos.length === 0 && (
          <p className="new-task-hint">
            {t.newTask.noRepos}{" "}
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId: project.id }}
              onClick={onClose}
            >
              {t.newTask.projectSettings}
            </Link>
          </p>
        )}

        <hr className="new-task-divider" />

        <section className="new-task-criteria" aria-label={t.newTask.acceptanceCriteria}>
          <div className="new-task-criteria-header">
            <span className="new-task-section-title">{t.newTask.acceptanceCriteria}</span>
            <span className="new-task-count">{filledCriteria(form).length}</span>
          </div>
          {form.criteria.map((criterion) => (
            <CriterionRow
              key={criterion.id}
              criterion={criterion}
              onChange={(patch) => updateCriterion(criterion.id, patch)}
              onRemove={() =>
                update({ criteria: form.criteria.filter((c) => c.id !== criterion.id) })
              }
            />
          ))}
          <div>
            <Button
              variant="ghost"
              className="new-task-add"
              icon={<Plus size={14} />}
              onClick={() => update({ criteria: [...form.criteria, newCriterion("agent")] })}
            >
              {t.newTask.addCriterion}
            </Button>
          </div>
        </section>
        <ErrorText error={create.error} />
      </div>

      <div className="new-task-footer">
        <span className="new-task-status" data-ready={ready} data-testid="new-task-status">
          <StatusDot color="currentColor" />
          {ready ? t.newTask.ready : t.newTask.backlog}
          {!ready && (
            <>
              <span className="new-task-missing-label">{t.newTask.missing}</span>
              {missing.map((item) => (
                <span key={item} className="new-task-missing">
                  {t.labels.readyRequirement[item]}
                </span>
              ))}
            </>
          )}
        </span>
        <Button variant="ghost" onClick={onClose}>
          {t.common.cancel}
        </Button>
        <Button disabled={!enabled || create.isPending} onClick={() => submit(false)}>
          {t.newTask.create}
        </Button>
        <Button
          variant="primary"
          disabled={!enabled || create.isPending}
          onClick={() => submit(true)}
          trailing={<span className="new-task-shortcut">{shortcutLabel("Enter")}</span>}
        >
          {t.newTask.createAndOpen}
        </Button>
      </div>
    </div>
  );
}

function RepoChip({
  repos,
  repo,
  onChange,
}: {
  repos: Repo[];
  repo: Repo | null;
  onChange: (repoId: string | null) => void;
}) {
  const t = useT();
  const menu = useMenu();
  const label = repo ? repoDisplayName(repo) : t.common.notSpecified;
  return (
    <>
      <button
        ref={menu.anchorRef}
        type="button"
        className="new-task-chip"
        data-tip={t.newTask.repo}
        {...menu.triggerProps}
      >
        <GitBranch size={14} className="new-task-chip-icon" aria-hidden="true" />
        <span className="new-task-chip-name">{t.newTask.repo}</span>
        <span className="new-task-chip-value">{label}</span>
      </button>
      <Popover
        {...menu.popoverProps}
        label={t.newTask.repo}
        minWidth={220}
        prefer="down"
        onSelect={onChange}
        groups={[
          {
            items: [
              ...repos.map((r) => ({
                value: r.id as string | null,
                label: repoDisplayName(r),
                mono: true,
                checked: r.id === repo?.id,
              })),
              {
                value: null,
                label: t.common.notSpecified,
                checked: repo === null,
              },
            ],
          },
        ]}
      />
    </>
  );
}

function AssigneeChip({
  members,
  assignee,
  onChange,
}: {
  members: Member[];
  assignee: Member | null;
  onChange: (memberId: string | null) => void;
}) {
  const t = useT();
  const menu = useMenu();
  return (
    <>
      <button
        ref={menu.anchorRef}
        type="button"
        className="new-task-chip"
        data-tip={t.newTask.assignee}
        {...menu.triggerProps}
      >
        <Avatar
          person={assignee ? { name: memberName(assignee), avatarUrl: assignee.avatarUrl } : null}
          size={16}
        />
        <span className="new-task-chip-name">{t.newTask.assignee}</span>
        <span className="new-task-chip-value">
          {assignee ? memberName(assignee) : t.common.unassigned}
        </span>
      </button>
      <Popover
        {...menu.popoverProps}
        label={t.newTask.assignee}
        minWidth={200}
        prefer="down"
        onSelect={onChange}
        groups={[
          {
            items: [
              ...members.map((m) => ({
                value: m.id as string | null,
                label: memberName(m),
                icon: <Avatar person={{ name: memberName(m), avatarUrl: m.avatarUrl }} size={18} />,
                checked: m.id === assignee?.id,
              })),
              {
                value: null,
                label: t.common.unassigned,
                icon: <Avatar person={null} size={18} />,
                checked: assignee === null,
              },
            ],
          },
        ]}
      />
    </>
  );
}

function DependsChip({
  tasks,
  dependency,
  onChange,
}: {
  tasks: Task[];
  dependency: Task | null;
  onChange: (taskId: string | null) => void;
}) {
  const t = useT();
  const menu = useMenu();
  const candidates = tasks.filter((task) => task.status !== "done");
  return (
    <>
      <button
        ref={menu.anchorRef}
        type="button"
        className="new-task-chip"
        data-tip={t.newTask.dependsOn}
        {...menu.triggerProps}
      >
        <GitMerge size={14} className="new-task-chip-icon" aria-hidden="true" />
        <span className="new-task-chip-name">{t.newTask.dependsOn}</span>
        <span className="new-task-chip-value">{dependency ? dependency.key : t.common.none}</span>
      </button>
      <Popover
        {...menu.popoverProps}
        label={t.newTask.dependsOn}
        minWidth={320}
        prefer="down"
        onSelect={onChange}
        groups={[
          {
            items: [
              { value: null as string | null, label: t.common.none, checked: dependency === null },
              ...candidates.map((task) => ({
                value: task.id as string | null,
                label: (
                  <>
                    <span className="new-task-dep-key">{task.key}</span>
                    {task.title}
                  </>
                ),
                ariaLabel: `${task.key} ${task.title}`,
                checked: task.id === dependency?.id,
              })),
            ],
          },
        ]}
      />
    </>
  );
}

function CriterionRow({
  criterion,
  onChange,
  onRemove,
}: {
  criterion: CriterionDraft;
  onChange: (patch: Partial<CriterionDraft>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const menu = useMenu();
  return (
    <div className="new-task-criterion">
      <span className="new-task-criterion-glyph" aria-hidden="true">
        ○
      </span>
      <input
        className="new-task-criterion-input"
        value={criterion.description}
        placeholder={t.newTask.criterionPlaceholder}
        aria-label={t.newTask.criterionPlaceholder}
        onChange={(event) => onChange({ description: event.target.value })}
      />
      <button
        ref={menu.anchorRef}
        type="button"
        className="new-task-kind"
        aria-label={`${t.newTask.criterionKind}：${t.labels.acKind[criterion.kind]}`}
        {...menu.triggerProps}
      >
        {t.labels.acKind[criterion.kind]}
      </button>
      <Popover
        {...menu.popoverProps}
        label={t.newTask.criterionKind}
        minWidth={240}
        prefer="down"
        onSelect={(kind: AcceptanceCriterionKind) => onChange({ kind })}
        groups={[
          {
            items: ACCEPTANCE_CRITERION_KINDS.map((kind) => ({
              value: kind,
              label: t.labels.acKind[kind],
              sub: t.labels.acKindDescription[kind],
              mono: true,
              checked: kind === criterion.kind,
            })),
          },
        ]}
      />
      {criterion.kind === "command" && (
        <input
          className="new-task-command"
          value={criterion.command}
          placeholder={t.newTask.commandPlaceholder}
          aria-label={t.newTask.commandPlaceholder}
          onChange={(event) => onChange({ command: event.target.value })}
        />
      )}
      <IconButton
        label={t.newTask.removeCriterion}
        icon={<X size={14} />}
        size={26}
        danger
        onClick={onRemove}
      />
    </div>
  );
}
