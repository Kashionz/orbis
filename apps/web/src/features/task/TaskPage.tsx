import type { Project, Task, UpdateTaskInput } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  membersQuery,
  projectsQuery,
  queryKeys,
  repoSpecsQuery,
  reposQuery,
  taskByKeyQuery,
  taskMentionsQuery,
  tasksQuery,
  updateTask,
} from "../../api/resources";
import { DoneReasonBadge } from "../../components/DoneReasonBadge";
import { ErrorText } from "../../components/ErrorText";
import { useT } from "../../i18n";
import { unfinishedDependencies } from "../../lib/dependencies";
import { type Permissions, usePermissions } from "../auth/use-permissions";
import { CollabEditor } from "../collab/CollabEditor";
import { DispatchDialog } from "../dispatch/DispatchDialog";
import { AcceptanceCriteriaSection } from "./AcceptanceCriteriaSection";
import { DependsOnField } from "./DependsOnField";
import { ReadyPanel } from "./ReadyPanel";
import { RunTree } from "./RunTree";
import { TaskComments } from "./TaskComments";

/** Task 頁（交付 2）：描述、Acceptance Criterion、depends_on、指派對象、Run 歷史。 */
export function TaskPage({ taskKey }: { taskKey: string }) {
  const { data: task } = useSuspenseQuery(taskByKeyQuery(taskKey));
  const { data: projects } = useSuspenseQuery(projectsQuery);
  const project = projects.find((p) => p.id === task.projectId);
  if (!project) throw new Error("找不到 Task 所在的 Project");
  return <TaskDetail task={task} project={project} />;
}

function useUpdateTask(task: Task) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTaskInput) => updateTask(task.id, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.taskByKey(updated.key), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks(updated.projectId) });
    },
  });
}

function TaskDetail({ task, project }: { task: Task; project: Project }) {
  const t = useT();
  const navigate = useNavigate();
  const permissions = usePermissions(project, task);
  const update = useUpdateTask(task);
  const [dispatching, setDispatching] = useState(false);
  const { data: repos = [] } = useQuery(reposQuery(project.id));
  const repo = repos.find((r) => r.id === task.repoId);
  const canEdit = permissions.can("task.edit");
  const canDispatch = permissions.can("run.dispatchLocal") || permissions.can("run.dispatchTeam");
  const { data: projectTasks = [] } = useQuery(tasksQuery(project.id));
  const blockers = unfinishedDependencies(task, projectTasks);
  const { data: mentions = [] } = useQuery(taskMentionsQuery(task.id));
  const { data: specs = [] } = useQuery({
    ...repoSpecsQuery(task.repoId ?? ""),
    enabled: task.repoId !== null && task.specPath !== null,
  });
  const spec = specs.find((s) => s.path === task.specPath);

  return (
    <main className="task-page">
      <nav className="breadcrumb">
        <Link to="/board" search={{ project: project.id }}>
          {project.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <span>{task.key}</span>
      </nav>
      <header className="page-header">
        <TitleField task={task} canEdit={canEdit} onSave={(title) => update.mutate({ title })} />
        <span className="status-badge" data-status={task.status}>
          {t.labels.taskStatus[task.status]}
        </span>
        <DoneReasonBadge task={task} />
        <span className="spacer" />
        {task.status === "ready" && canDispatch && (
          <>
            {blockers.length > 0 && (
              <span className="hint" role="note">
                依賴的 {blockers.map((t) => t.key).join("、")} 還沒有 Done，不能派工
              </span>
            )}
            <button
              type="button"
              className="primary"
              disabled={blockers.length > 0}
              onClick={() => setDispatching(true)}
            >
              派工
            </button>
          </>
        )}
      </header>
      <ErrorText error={update.error} />

      <div className="task-layout">
        <div className="task-main">
          <section className="section" aria-labelledby="description-heading">
            <h2 id="description-heading">描述</h2>
            <CollabEditor
              docRef={{ kind: "task-description", id: task.id }}
              label="描述"
              canEdit={canEdit}
              projectId={project.id}
              mentions={mentions}
              placeholder="描述要做什麼。輸入 @ 提及成員或 Agent。"
            />
          </section>
          <AcceptanceCriteriaSection taskId={task.id} projectId={project.id} canEdit={canEdit} />
          <RunTree taskId={task.id} permissions={permissions} />
          <TaskComments
            taskId={task.id}
            projectId={project.id}
            memberId={permissions.ctx.memberId}
            canComment={permissions.can("view")}
          />
        </div>
        <aside className="task-side">
          <ReadyPanel task={task} canEdit={canEdit} />
          <dl>
            <dt>Repo</dt>
            <dd>{repo ? `${repo.owner}/${repo.name}` : "尚未指定"}</dd>
          </dl>
          {task.specPath && (
            <dl>
              <dt>Spec</dt>
              <dd>
                {spec ? (
                  <Link to="/repo-specs/$repoSpecId" params={{ repoSpecId: spec.id }}>
                    {task.specPath}
                  </Link>
                ) : (
                  <code>{task.specPath}</code>
                )}
              </dd>
            </dl>
          )}
          <AssigneeField
            task={task}
            permissions={permissions}
            onSave={(assigneeMemberId) => update.mutate({ assigneeMemberId })}
          />
          <DependsOnField
            task={task}
            canEdit={canEdit}
            onSave={(dependsOn) => update.mutate({ dependsOn })}
          />
          <PlanGateField
            task={task}
            project={project}
            canEdit={canEdit}
            onSave={(planGateEnabled) => update.mutate({ planGateEnabled })}
          />
        </aside>
      </div>

      <DispatchDialog
        task={task}
        project={project}
        open={dispatching}
        onClose={() => setDispatching(false)}
        onDispatched={(run) => void navigate({ to: "/runs/$runId", params: { runId: run.id } })}
      />
    </main>
  );
}

function TitleField({
  task,
  canEdit,
  onSave,
}: {
  task: Task;
  canEdit: boolean;
  onSave: (title: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <h1 className="task-heading">
        <span className="task-key">{task.key}</span> {task.title}
        {canEdit && (
          <button type="button" className="link-button" onClick={() => setDraft(task.title)}>
            編輯標題
          </button>
        )}
      </h1>
    );
  }
  return (
    <form
      className="title-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim() !== "") onSave(draft.trim());
        setDraft(null);
      }}
    >
      <input
        aria-label="標題"
        value={draft}
        maxLength={200}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="submit" className="primary">
        儲存
      </button>
      <button type="button" onClick={() => setDraft(null)}>
        取消
      </button>
    </form>
  );
}

function AssigneeField({
  task,
  permissions,
  onSave,
}: {
  task: Task;
  permissions: Permissions;
  onSave: (assigneeMemberId: string | null) => void;
}) {
  const { data: members = [] } = useQuery(membersQuery);
  const assignee = members.find((m) => m.id === task.assigneeMemberId);
  return (
    <dl>
      <dt>
        <label htmlFor="assignee">指派對象</label>
      </dt>
      <dd>
        {permissions.can("task.edit") ? (
          <select
            id="assignee"
            value={task.assigneeMemberId ?? ""}
            onChange={(event) => onSave(event.target.value === "" ? null : event.target.value)}
          >
            <option value="">未指派</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                @{member.githubLogin}
                {member.name ? `（${member.name}）` : ""}
              </option>
            ))}
          </select>
        ) : (
          <span id="assignee">{assignee ? `@${assignee.githubLogin}` : "未指派"}</span>
        )}
      </dd>
    </dl>
  );
}

/** Task 層級的 Plan Gate 設定：沿用 Project，或在這個 Task 開啟、關閉（§5）。 */
function PlanGateField({
  task,
  project,
  canEdit,
  onSave,
}: {
  task: Task;
  project: Project;
  canEdit: boolean;
  onSave: (planGateEnabled: boolean | null) => void;
}) {
  const inherited = `沿用 Project（${project.policy.planGateEnabled ? "開啟" : "關閉"}）`;
  const value = task.planGateEnabled === null ? "inherit" : task.planGateEnabled ? "on" : "off";
  const labels = { inherit: inherited, on: "開啟", off: "關閉" } as const;
  return (
    <dl>
      <dt>
        <label htmlFor="plan-gate">Plan Gate</label>
      </dt>
      <dd>
        {canEdit ? (
          <select
            id="plan-gate"
            value={value}
            onChange={(event) =>
              onSave(event.target.value === "inherit" ? null : event.target.value === "on")
            }
          >
            <option value="inherit">{labels.inherit}</option>
            <option value="on">{labels.on}</option>
            <option value="off">{labels.off}</option>
          </select>
        ) : (
          <span id="plan-gate">{labels[value]}</span>
        )}
      </dd>
    </dl>
  );
}
