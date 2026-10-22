import type { Project, Task, UpdateTaskInput } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  membersQuery,
  projectsQuery,
  queryKeys,
  reposQuery,
  taskByKeyQuery,
  updateTask,
} from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { TASK_STATUS_LABELS } from "../../lib/labels";
import { type Permissions, usePermissions } from "../auth/use-permissions";
import { DispatchDialog } from "../dispatch/DispatchDialog";
import { AcceptanceCriteriaSection } from "./AcceptanceCriteriaSection";
import { DependsOnField } from "./DependsOnField";
import { DescriptionEditor } from "./DescriptionEditor";
import { RunHistory } from "./RunHistory";

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
  const navigate = useNavigate();
  const permissions = usePermissions(project, task);
  const update = useUpdateTask(task);
  const [dispatching, setDispatching] = useState(false);
  const { data: repos = [] } = useQuery(reposQuery(project.id));
  const repo = repos.find((r) => r.id === task.repoId);
  const canEdit = permissions.can("task.edit");
  const canDispatch = permissions.can("run.dispatchLocal") || permissions.can("run.dispatchTeam");

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
          {TASK_STATUS_LABELS[task.status]}
        </span>
        <span className="spacer" />
        {task.status === "ready" && canDispatch && (
          <button type="button" className="primary" onClick={() => setDispatching(true)}>
            派工
          </button>
        )}
      </header>
      <ErrorText error={update.error} />

      <div className="task-layout">
        <div className="task-main">
          <DescriptionEditor
            value={task.description}
            canEdit={canEdit}
            saving={update.isPending}
            onSave={(description) => update.mutateAsync({ description })}
          />
          <AcceptanceCriteriaSection taskId={task.id} canEdit={canEdit} />
          <RunHistory taskId={task.id} />
        </div>
        <aside className="task-side">
          <dl>
            <dt>Repo</dt>
            <dd>{repo ? `${repo.owner}/${repo.name}` : "—"}</dd>
          </dl>
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
