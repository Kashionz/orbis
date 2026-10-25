// 看板（README「Board」）：標題、Project 選單、篩選（全部／待我處理／指派給我）、檢視（列表／分欄）、
// 新增任務。列表依狀態分組、可以收合；分欄每個狀態一欄。拖曳沿用 @dnd-kit 與原本的轉換規則：
// 只能在待辦與就緒之間移動，拖到執行中會打開派工對話框。

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
import {
  canTransitionManually,
  type Member,
  type Project,
  TASK_STATUSES,
  type Task,
  type TaskStatus,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Columns3, List, Plus } from "lucide-react";
import { type CSSProperties, type ReactNode, useMemo, useRef, useState } from "react";
import {
  draftTasksQuery,
  membersQuery,
  needsYouQuery,
  projectsQuery,
  queryKeys,
  tasksQuery,
  transitionTask,
} from "../../api/resources";
import { AgentLogo } from "../../components/AgentLogo";
import { DoneReasonBadge } from "../../components/DoneReasonBadge";
import { Avatar } from "../../components/Avatar";
import { ErrorText } from "../../components/ErrorText";
import { useElementWidth } from "../../components/hooks";
import { type MenuGroup, Popover } from "../../components/Popover";
import { Segmented } from "../../components/Segmented";
import { StatusDot } from "../../components/StatusDot";
import { useT } from "../../i18n";
import { unfinishedDependencies } from "../../lib/dependencies";
import { isFeatureEnabled } from "../../lib/features";
import { usePersistentState } from "../../lib/storage";
import { type Permissions, usePermissions } from "../auth/use-permissions";
import { DispatchDialog } from "../dispatch/DispatchDialog";
import { CreateProjectDialog } from "../project/CreateProjectDialog";
import { runTone, TONE_COLOR, taskTone } from "../run/run-tone";
import { relativeTime } from "../run/stream/time-format";
import { useNow } from "../run/workspace/use-now";
import { useShell } from "../shell/shell-context";
import { MainColumn } from "../shell/WorkspaceLayout";
import { useBoardSummaries } from "./api";
import {
  acceptanceBar,
  type BoardFilter,
  type BoardRow,
  type BoardView,
  boardGroups,
  boardListColumns,
  canAddTo,
  needsCount,
} from "./board-model";
import { boardViewState } from "./board-prefs";
import "../run/scope.css";
import "./board.css";

const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

/**
 * 可以把 Task 放到 `to` 嗎？拖到執行中代表派工：Task 要是就緒，而且依賴都已完成。
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
  return canTransitionManually(task.status, to);
}

function isDraggable(task: Task, tasks: readonly Task[], permissions: Permissions): boolean {
  return TASK_STATUSES.some((to) => to !== task.status && canDrop(task, to, tasks, permissions));
}

export function BoardPage({ projectId }: { projectId: string | undefined }) {
  const { data: projects } = useSuspenseQuery(projectsQuery);
  const shell = useShell();
  const project = projects.find((p) => p.id === projectId) ?? shell.project ?? projects[0];
  if (!project) return <NoProjects />;
  return <Board key={project.id} project={project} projects={projects} />;
}

function NoProjects() {
  const t = useT();
  // 建立 Project 看的是 Team 的 Role
  const teamPermissions = usePermissions();
  const [creating, setCreating] = useState(false);
  return (
    <MainColumn className="bd">
      <div className="bd-empty-page">
        <span className="bd-title">{t.board.noProjects}</span>
        {teamPermissions.can("project.manage") ? (
          <button
            type="button"
            className="o-btn"
            data-variant="primary"
            onClick={() => setCreating(true)}
          >
            {t.board.newProject}
          </button>
        ) : (
          <span className="bd-muted">{t.board.askAdmin}</span>
        )}
      </div>
      <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />
    </MainColumn>
  );
}

function Board({ project, projects }: { project: Project; projects: Project[] }) {
  const t = useT();
  const b = t.board;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const shell = useShell();
  const permissions = usePermissions(project);
  const { data: tasks = [], error: loadError } = useQuery(tasksQuery(project.id));
  const { data: members = [] } = useQuery(membersQuery);
  const { data: drafts = [] } = useQuery(draftTasksQuery(project.id));
  const { data: needs = [] } = useQuery(needsYouQuery);
  const [filter, setFilter] = usePersistentState(boardViewState.filter);
  const [view, setView] = usePersistentState(boardViewState.view);
  const [collapsed, setCollapsed] = useState<ReadonlySet<TaskStatus>>(() => new Set(["done"]));
  const [dragging, setDragging] = useState<Task | null>(null);
  const [dispatching, setDispatching] = useState<Task | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(bodyRef);
  const columns = boardListColumns(width || null);
  const now = useNow(60_000);

  const needsTaskIds = useMemo(() => new Set(needs.map((n) => n.taskId)), [needs]);
  const visibleTasks = useMemo(
    () => tasks.map((task) => ({ id: task.id, status: task.status })),
    [tasks],
  );
  const summaries = useBoardSummaries(project.id, visibleTasks, isFeatureEnabled("boardSummary"));
  const input = {
    tasks,
    drafts,
    needsTaskIds,
    runs: summaries.runs,
    acceptance: summaries.acceptance,
    meId: permissions.ctx.memberId,
    filter,
  };
  const groups = boardGroups(input, view === "columns");
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const transition = useMutation({
    mutationFn: ({ task, status }: { task: Task; status: TaskStatus }) =>
      transitionTask(task.id, status),
    onMutate: async ({ task, status }) => {
      // 先移到新的位置，失敗時還原
      const key = queryKeys.tasks(project.id);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Task[]>(key);
      queryClient.setQueryData<Task[]>(key, (list) =>
        list?.map((item) => (item.id === task.id ? { ...item, status } : item)),
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
    setDragging(tasks.find((task) => task.id === event.active.id) ?? null);
  }

  function onDragEnd(event: DragEndEvent) {
    setDragging(null);
    const task = tasks.find((item) => item.id === event.active.id);
    const to = event.over?.id as TaskStatus | undefined;
    if (!task || !to || to === task.status || !canDrop(task, to, tasks, permissions)) return;
    if (to === "running") {
      setDispatching(task);
      return;
    }
    transition.mutate({ task, status: to });
  }

  function toggleGroup(status: TaskStatus) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  const openTask = (task: Task) =>
    void navigate({ to: "/tasks/$taskKey", params: { taskKey: task.key } });
  const openDrafts = () =>
    void navigate({ to: "/projects/$projectId/draft-tasks", params: { projectId: project.id } });
  const canCreate = permissions.can("task.edit");
  const rowProps = {
    allTasks: tasks,
    members: memberById,
    permissions,
    now,
    onOpenTask: openTask,
    onOpenDrafts: openDrafts,
  };

  return (
    <MainColumn className="bd">
      <header className="bd-header">
        <h1 className="bd-title">{b.title}</h1>
        <ProjectMenu project={project} projects={projects} draftCount={drafts.length} />
        <span className="bd-spacer" />
        <Segmented<BoardFilter>
          label={b.filter.label}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: b.filter.all },
            { value: "needs", label: b.filter.needs, count: needsCount(input), countTone: "warn" },
            { value: "mine", label: b.filter.mine },
          ]}
        />
        <Segmented<BoardView>
          label={b.view.label}
          value={view}
          onChange={setView}
          options={[
            { value: "list", label: b.view.list, icon: <List {...ICON} /> },
            { value: "columns", label: b.view.columns, icon: <Columns3 {...ICON} /> },
          ]}
        />
        {canCreate && (
          <button
            type="button"
            className="o-btn"
            data-variant="primary"
            onClick={() => shell.openNewTask({ projectId: project.id })}
          >
            <Plus {...ICON} />
            {b.newTask}
          </button>
        )}
      </header>
      <ErrorText error={loadError ?? transition.error} />

      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        {view === "list" ? (
          <div ref={bodyRef} className="bd-list" data-testid="board-list">
            {groups.length === 0 ? (
              <div className="bd-empty">{b.empty}</div>
            ) : (
              <div className="bd-list-head" style={{ gridTemplateColumns: columns.template }}>
                <span />
                <span>{b.column.key}</span>
                <span>{b.column.title}</span>
                <span>{b.column.run}</span>
                {columns.wide && <span>{b.column.agent}</span>}
                <span>{b.column.acceptance}</span>
                <span>{b.column.assignee}</span>
                {columns.wide && <span className="bd-right">{b.column.updated}</span>}
              </div>
            )}
            {groups.map((group) => {
              const open = !collapsed.has(group.status);
              return (
                <DropZone
                  key={group.status}
                  status={group.status}
                  className="bd-group"
                  dropAllowed={
                    dragging ? canDrop(dragging, group.status, tasks, permissions) : null
                  }
                >
                  <div className="bd-group-head">
                    <button
                      type="button"
                      className="bd-group-toggle"
                      aria-expanded={open}
                      onClick={() => toggleGroup(group.status)}
                    >
                      <span className="bd-chevron" data-open={open}>
                        <ChevronRight {...ICON} />
                      </span>
                      <span
                        className="bd-dot"
                        style={{ background: TONE_COLOR[taskTone(group.status)] }}
                      />
                      {t.labels.taskStatus[group.status]}
                      <span className="bd-count">{group.rows.length}</span>
                    </button>
                    {canCreate && canAddTo(group.status) && (
                      <button
                        type="button"
                        className="bd-add"
                        aria-label={b.newTask}
                        data-tip={b.newTask}
                        onClick={() => shell.openNewTask({ projectId: project.id })}
                      >
                        <Plus {...ICON} />
                      </button>
                    )}
                  </div>
                  {open && (
                    <div className="bd-rows">
                      {group.rows.map((row) => (
                        <ListRow
                          key={row.key}
                          row={row}
                          template={columns.template}
                          wide={columns.wide}
                          {...rowProps}
                        />
                      ))}
                    </div>
                  )}
                </DropZone>
              );
            })}
          </div>
        ) : (
          <div className="bd-columns" data-testid="board-columns">
            {groups.map((group) => (
              <DropZone
                key={group.status}
                status={group.status}
                className="bd-column"
                dropAllowed={dragging ? canDrop(dragging, group.status, tasks, permissions) : null}
                ariaLabel={t.labels.taskStatus[group.status]}
              >
                <div className="bd-column-head">
                  <span
                    className="bd-dot"
                    style={{ background: TONE_COLOR[taskTone(group.status)] }}
                  />
                  <h2 className="bd-column-title">{t.labels.taskStatus[group.status]}</h2>
                  <span className="bd-count">{group.rows.length}</span>
                  {canCreate && canAddTo(group.status) && (
                    <button
                      type="button"
                      className="bd-add bd-add-end"
                      aria-label={b.newTask}
                      data-tip={b.newTask}
                      onClick={() => shell.openNewTask({ projectId: project.id })}
                    >
                      <Plus {...ICON} />
                    </button>
                  )}
                </div>
                <div className="bd-cards">
                  {group.rows.length === 0 && (
                    <span className="bd-muted bd-column-empty">{b.emptyColumn}</span>
                  )}
                  {group.rows.map((row) => (
                    <Card key={row.key} row={row} {...rowProps} />
                  ))}
                </div>
              </DropZone>
            ))}
          </div>
        )}
      </DndContext>

      {dispatching && (
        <DispatchDialog
          task={dispatching}
          project={project}
          open
          onClose={() => setDispatching(null)}
          onDispatched={(run) =>
            void navigate({
              to: "/tasks/$taskKey",
              params: { taskKey: dispatching.key },
              search: { run: run.id },
            })
          }
        />
      )}
    </MainColumn>
  );
}

function DropZone({
  status,
  className,
  dropAllowed,
  ariaLabel,
  children,
}: {
  status: TaskStatus;
  className: string;
  /** 拖曳中時這一組能不能放；沒有在拖曳時為 null。 */
  dropAllowed: boolean | null;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: dropAllowed === false });
  return (
    <section
      ref={setNodeRef}
      className={className}
      data-status={status}
      aria-label={ariaLabel}
      data-drop-allowed={dropAllowed === null ? undefined : String(dropAllowed)}
      data-over={isOver && dropAllowed ? "true" : undefined}
    >
      {children}
    </section>
  );
}

interface RowProps {
  row: BoardRow;
  allTasks: readonly Task[];
  members: ReadonlyMap<string, Member>;
  permissions: Permissions;
  now: number;
  onOpenTask: (task: Task) => void;
  onOpenDrafts: () => void;
}

/** 拖曳用的屬性；不能拖的 Task 不加。 */
function useDrag(task: Task | null, draggable: boolean) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task?.id ?? "draft",
    disabled: !draggable || task === null,
  });
  const style: CSSProperties | undefined = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return {
    ref: setNodeRef,
    style,
    isDragging,
    props: draggable ? { ...attributes, ...listeners } : {},
  };
}

function RunCell({ row }: { row: Extract<BoardRow, { kind: "task" }> }) {
  const t = useT();
  if (!row.run) return <span />;
  const color = TONE_COLOR[runTone(row.run.status)];
  const label =
    row.run.status === "awaiting_gate" && row.run.gate
      ? row.run.gate === "plan"
        ? t.board.awaitingPlanGate
        : t.board.awaitingReviewGate
      : t.labels.runStatus[row.run.status];
  return (
    <span className="bd-run" style={{ color }}>
      {row.live && <StatusDot color="currentColor" live />}
      <span className="bd-ellipsis">{label}</span>
    </span>
  );
}

function AcceptanceCell({
  row,
  width,
}: {
  row: Extract<BoardRow, { kind: "task" }>;
  width: number;
}) {
  if (!row.acceptance || row.acceptance.total === 0) return <span />;
  const bar = acceptanceBar(row.acceptance);
  return (
    <span className="bd-ac">
      <span className="bd-ac-bar" style={{ width }}>
        <span
          className="bd-ac-fill"
          data-failed={bar.failed}
          style={{ width: `${bar.percent}%` }}
        />
      </span>
      <span className="bd-mono">
        {row.acceptance.passed}/{row.acceptance.total}
      </span>
    </span>
  );
}

function AssigneeAvatar({ member, size }: { member: Member | undefined; size: number }) {
  return (
    <Avatar
      person={member ? { name: member.githubLogin, avatarUrl: member.avatarUrl } : null}
      size={size}
    />
  );
}

function ListRow({
  row,
  template,
  wide,
  allTasks,
  members,
  permissions,
  now,
  onOpenTask,
  onOpenDrafts,
}: RowProps & { template: string; wide: boolean }) {
  const t = useT();
  const b = t.board;
  const task = row.kind === "task" ? row.task : null;
  const drag = useDrag(task, task !== null && isDraggable(task, allTasks, permissions));
  if (row.kind === "draft") {
    return (
      <button
        type="button"
        className="bd-row"
        style={{ gridTemplateColumns: template }}
        onClick={onOpenDrafts}
      >
        <span />
        <span className="bd-key">#{row.draft.position}</span>
        <span className="bd-row-title">
          <span className="bd-ellipsis">{row.draft.title}</span>
          <span className="bd-pill">{b.draft}</span>
        </span>
        <span />
        {wide && <span />}
        <span />
        <span />
        {wide && <span />}
      </button>
    );
  }
  const assignee = row.task.assigneeMemberId ? members.get(row.task.assigneeMemberId) : undefined;
  return (
    <div
      ref={drag.ref}
      className="bd-row"
      style={{ gridTemplateColumns: template, ...drag.style }}
      data-task-key={row.task.key}
      data-dragging={drag.isDragging ? "true" : undefined}
      {...drag.props}
    >
      <span
        className="bd-needs"
        data-needs={row.needs}
        data-tip={row.needs ? b.needs : undefined}
      />
      <span className="bd-key">{row.task.key}</span>
      <span className="bd-row-title">
        <Link
          to="/tasks/$taskKey"
          params={{ taskKey: row.task.key }}
          className="bd-ellipsis bd-link"
          onClick={(event) => {
            event.preventDefault();
            onOpenTask(row.task);
          }}
        >
          {row.task.title}
        </Link>
        <DoneReasonBadge task={row.task} />
        {row.blockedBy.length > 0 && (
          <span className="bd-blocked">{b.blockedBy(row.blockedBy.join(" "))}</span>
        )}
      </span>
      <RunCell row={row} />
      {wide && (
        <span className="bd-agent">
          {row.run && (
            <>
              <AgentLogo agent={row.run.agent} size={14} />
              <span className="bd-mono bd-ellipsis">{row.run.agent}</span>
            </>
          )}
        </span>
      )}
      <AcceptanceCell row={row} width={28} />
      <span className="bd-assignee">
        <AssigneeAvatar member={assignee} size={18} />
        <span className="bd-ellipsis bd-muted">
          {assignee ? `@${assignee.githubLogin}` : t.common.unassigned}
        </span>
      </span>
      {wide && (
        <span className="bd-updated">{relativeTime(row.task.updatedAt, now, t.common)}</span>
      )}
    </div>
  );
}

function Card({ row, allTasks, members, permissions, onOpenTask, onOpenDrafts }: RowProps) {
  const t = useT();
  const b = t.board;
  const task = row.kind === "task" ? row.task : null;
  const drag = useDrag(task, task !== null && isDraggable(task, allTasks, permissions));
  if (row.kind === "draft") {
    return (
      <button type="button" className="bd-card" onClick={onOpenDrafts}>
        <span className="bd-card-top">
          <span className="bd-key">#{row.draft.position}</span>
          <span className="bd-pill">{b.draft}</span>
        </span>
        <span className="bd-card-title">{row.draft.title}</span>
      </button>
    );
  }
  const assignee = row.task.assigneeMemberId ? members.get(row.task.assigneeMemberId) : undefined;
  return (
    <article
      ref={drag.ref}
      className="bd-card"
      style={drag.style}
      data-task-key={row.task.key}
      data-dragging={drag.isDragging ? "true" : undefined}
      aria-label={`${row.task.key} ${row.task.title}`}
      {...drag.props}
    >
      <span className="bd-card-top">
        <span className="bd-key">{row.task.key}</span>
        {row.needs && <span className="bd-needs" data-needs="true" data-tip={b.needs} />}
        <DoneReasonBadge task={row.task} />
        <span
          className="bd-card-avatar"
          data-tip={assignee ? `@${assignee.githubLogin}` : t.common.unassigned}
        >
          <AssigneeAvatar member={assignee} size={18} />
        </span>
      </span>
      <Link
        to="/tasks/$taskKey"
        params={{ taskKey: row.task.key }}
        className="bd-card-title bd-link"
        onClick={(event) => {
          event.preventDefault();
          onOpenTask(row.task);
        }}
      >
        {row.task.title}
      </Link>
      {(row.run || row.acceptance) && (
        <span className="bd-card-meta">
          {row.run && (
            <span className="bd-card-run">
              <AgentLogo agent={row.run.agent} size={14} />
              <RunCell row={row} />
            </span>
          )}
          <span className="bd-spacer" />
          <AcceptanceCell row={row} width={24} />
        </span>
      )}
    </article>
  );
}

/** 標題列的 Project 名稱：切換 Project、Project 設定、草稿任務、新增 Project。 */
function ProjectMenu({
  project,
  projects,
  draftCount,
}: {
  project: Project;
  projects: Project[];
  draftCount: number;
}) {
  const t = useT();
  const b = t.board;
  const navigate = useNavigate();
  const shell = useShell();
  const teamPermissions = usePermissions();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  type Action = { kind: "project"; id: string } | { kind: "settings" | "drafts" | "new" };
  const groups: MenuGroup<Action>[] = [
    {
      items: projects.map((p) => ({
        value: { kind: "project", id: p.id },
        label: p.name,
        sub: p.keyPrefix,
        checked: p.id === project.id,
      })),
    },
    {
      items: [
        { value: { kind: "settings" }, label: b.projectSettings },
        {
          value: { kind: "drafts" },
          label: draftCount > 0 ? `${b.draftTasks} ${draftCount}` : b.draftTasks,
        },
        ...(teamPermissions.can("project.manage")
          ? [{ value: { kind: "new" } as Action, label: b.newProject }]
          : []),
      ],
    },
  ];
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="bd-project"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${b.project} ${project.name}`}
        onClick={() => setOpen((v) => !v)}
      >
        {project.name}
        {draftCount > 0 && (
          <span className="bd-draft-count" data-testid="draft-task-count">
            {draftCount}
          </span>
        )}
        <ChevronDown {...ICON} />
      </button>
      <Popover<Action>
        anchorRef={ref}
        open={open}
        onClose={() => setOpen(false)}
        groups={groups}
        label={b.project}
        prefer="down"
        minWidth={220}
        onSelect={(action) => {
          if (action.kind === "project") {
            shell.setProject(action.id);
            void navigate({ to: "/board", search: { project: action.id } });
          } else if (action.kind === "settings") {
            void navigate({
              to: "/projects/$projectId/settings",
              params: { projectId: project.id },
            });
          } else if (action.kind === "drafts") {
            void navigate({
              to: "/projects/$projectId/draft-tasks",
              params: { projectId: project.id },
            });
          } else {
            setCreating(true);
          }
        }}
      />
      <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
