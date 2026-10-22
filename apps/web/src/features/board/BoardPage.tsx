import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { type Project, TASK_STATUSES, type Task, type TaskStatus } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  membersQuery,
  projectsQuery,
  queryKeys,
  tasksQuery,
  transitionTask,
} from "../../api/resources";
import { MANUAL_TASK_TRANSITIONS, type Member } from "../../api/schemas";
import { ErrorText } from "../../components/ErrorText";
import { unfinishedDependencies } from "../../lib/dependencies";
import { TASK_STATUS_LABELS } from "../../lib/labels";
import { matchesTaskKey, parseTaskKeyQuery } from "../../lib/task-key-search";
import { type Permissions, usePermissions } from "../auth/use-permissions";
import { DispatchDialog } from "../dispatch/DispatchDialog";
import { CreateTaskDialog } from "./CreateTaskDialog";

/**
 * 可以把 Task 放到 `to` 欄嗎？拖到 Running 代表派工：Task 要是 Ready，
 * 而且 depends_on 中的 Task 都已經 Done。
 */
function canDrop(
  task: Task,
  to: TaskStatus,
  tasks: readonly Task[],
  permissions: Permissions,
): boolean {
  if (!permissions.can("task.edit")) return false;
  if (to === "running") {
    return (
      task.status === "ready" &&
      unfinishedDependencies(task, tasks).length === 0 &&
      (permissions.can("run.dispatchLocal") || permissions.can("run.dispatchTeam"))
    );
  }
  return MANUAL_TASK_TRANSITIONS[task.status].includes(to);
}

function isDraggable(task: Task, tasks: readonly Task[], permissions: Permissions): boolean {
  return TASK_STATUSES.some((to) => to !== task.status && canDrop(task, to, tasks, permissions));
}

export function BoardPage({ projectId }: { projectId: string | undefined }) {
  const { data: projects } = useSuspenseQuery(projectsQuery);
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  if (!project) {
    return (
      <main className="notice">
        <h1>還沒有任何 Project</h1>
      </main>
    );
  }
  return <Board key={project.id} project={project} projects={projects} />;
}

function Board({ project, projects }: { project: Project; projects: Project[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const permissions = usePermissions(project);
  const { data: tasks = [], error: loadError } = useQuery(tasksQuery(project.id));
  const { data: members = [] } = useQuery(membersQuery);
  const [search, setSearch] = useState("");
  const [dragging, setDragging] = useState<Task | null>(null);
  const [dispatching, setDispatching] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);

  const query = parseTaskKeyQuery(search);
  const visible = tasks.filter((t) => matchesTaskKey(t.key, query));

  const transition = useMutation({
    mutationFn: ({ task, status }: { task: Task; status: TaskStatus }) =>
      transitionTask(task.id, status),
    onMutate: async ({ task, status }) => {
      // 先移到新欄位，失敗時還原
      const key = queryKeys.tasks(project.id);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Task[]>(key);
      queryClient.setQueryData<Task[]>(key, (list) =>
        list?.map((t) => (t.id === task.id ? { ...t, status } : t)),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous)
        queryClient.setQueryData(queryKeys.tasks(project.id), context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.tasks(project.id) }),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  function onDragStart(event: DragStartEvent) {
    setDragging(tasks.find((t) => t.id === event.active.id) ?? null);
  }

  function onDragEnd(event: DragEndEvent) {
    setDragging(null);
    const task = tasks.find((t) => t.id === event.active.id);
    const to = event.over?.id as TaskStatus | undefined;
    if (!task || !to || to === task.status || !canDrop(task, to, tasks, permissions)) return;
    if (to === "running") {
      setDispatching(task);
      return;
    }
    transition.mutate({ task, status: to });
  }

  function openExactMatch() {
    if (!query?.exact) return;
    const [match] = visible;
    if (visible.length === 1 && match) {
      void navigate({ to: "/tasks/$taskKey", params: { taskKey: match.key } });
    }
  }

  return (
    <main className="board-page">
      <div className="toolbar">
        <label className="field-inline">
          Project
          <select
            value={project.id}
            onChange={(event) =>
              void navigate({ to: "/board", search: { project: event.target.value } })
            }
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.keyPrefix}）
              </option>
            ))}
          </select>
        </label>
        <input
          type="search"
          className="search"
          placeholder={`用 Task Key 搜尋，例如 ${project.keyPrefix}-1`}
          aria-label="用 Task Key 搜尋"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") openExactMatch();
          }}
        />
        <span className="spacer" />
        {permissions.can("task.edit") && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            新增 Task
          </button>
        )}
      </div>
      <ErrorText error={loadError ?? transition.error} />

      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="board">
          {TASK_STATUSES.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={visible.filter((t) => t.status === status)}
              allTasks={tasks}
              members={members}
              permissions={permissions}
              dropAllowed={dragging ? canDrop(dragging, status, tasks, permissions) : null}
            />
          ))}
        </div>
      </DndContext>

      {dispatching && (
        <DispatchDialog
          task={dispatching}
          project={project}
          open
          onClose={() => setDispatching(null)}
          onDispatched={(run) => void navigate({ to: "/runs/$runId", params: { runId: run.id } })}
        />
      )}
      <CreateTaskDialog project={project} open={creating} onClose={() => setCreating(false)} />
    </main>
  );
}

interface ColumnProps {
  status: TaskStatus;
  tasks: Task[];
  /** Project 中所有的 Task（判斷 depends_on 用）。 */
  allTasks: Task[];
  members: Member[];
  permissions: Permissions;
  /** 拖曳中時這一欄能不能放；沒有在拖曳時為 null。 */
  dropAllowed: boolean | null;
}

function Column({ status, tasks, allTasks, members, permissions, dropAllowed }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: dropAllowed === false });
  return (
    <section
      ref={setNodeRef}
      className="board-column"
      data-status={status}
      data-drop-allowed={dropAllowed === null ? undefined : String(dropAllowed)}
      data-over={isOver && dropAllowed ? "true" : undefined}
      aria-labelledby={`column-${status}`}
    >
      <h2 id={`column-${status}`}>
        {TASK_STATUS_LABELS[status]} <span className="count">{tasks.length}</span>
      </h2>
      {tasks.length === 0 && <p className="empty">沒有 Task</p>}
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          assignee={members.find((m) => m.id === task.assigneeMemberId)}
          draggable={isDraggable(task, allTasks, permissions)}
        />
      ))}
    </section>
  );
}

function TaskCard({
  task,
  assignee,
  draggable,
}: {
  task: Task;
  assignee: Member | undefined;
  draggable: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    disabled: !draggable,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <article
      ref={setNodeRef}
      className="task-card"
      data-task-key={task.key}
      data-dragging={isDragging ? "true" : undefined}
      style={style}
      {...(draggable ? { ...attributes, ...listeners } : {})}
      aria-label={`${task.key} ${task.title}`}
    >
      <Link to="/tasks/$taskKey" params={{ taskKey: task.key }} className="task-key">
        {task.key}
      </Link>
      <div className="task-title">{task.title}</div>
      {assignee && <div className="task-assignee">@{assignee.githubLogin}</div>}
    </article>
  );
}
