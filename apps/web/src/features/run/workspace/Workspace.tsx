// Task 的工作區（README「Run Workspace」）：標題列、事件串流與輸入框、右側的任務／差異／預覽／終端機分頁。
// 還沒有執行（或要重新派工）時主欄顯示派工表單。

import type { Project, Run, Task } from "@orbis/api-contract";
import { TERMINAL_RUN_STATUSES } from "@orbis/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { errorMessage } from "../../../api/client";
import {
  acceptanceCriteriaQuery,
  cancelRun,
  decideGate,
  membersQuery,
  needsYouQuery,
  queryKeys,
  taskRunsQuery,
} from "../../../api/resources";
import { ErrorText } from "../../../components/ErrorText";
import { useToast } from "../../../components/Toast";
import { useT } from "../../../i18n";
import { usePreferences } from "../../../lib/preferences";
import { usePermissions } from "../../auth/use-permissions";
import { PreviewPanel } from "../../preview/PreviewPanel";
import { usePanel } from "../../shell/use-panel";
import { WorkspaceLayout } from "../../shell/WorkspaceLayout";
import { Composer } from "../composer/Composer";
import type { PendingPermission } from "../composer/composer-state";
import { DiffTab, useDiffStats } from "../panel/DiffTab";
import { RightPanel, type TabBadges } from "../panel/RightPanel";
import { TaskTab } from "../panel/TaskTab";
import { TerminalTab } from "../panel/TerminalTab";
import { EventStream } from "../stream/EventStream";
import { type StreamEnv, StreamProvider, useExpansion } from "../stream/stream-context";
import { buildStream, streamTail, withExtras } from "../stream/stream-model";
import type { TimelineItem } from "../timeline";
import { withdrawRunPrompt } from "../workspace-api";
import { NoRunView } from "./NoRunView";
import type { WorkspaceTab } from "./route-state";
import { useNow } from "./use-now";
import { useRunWorkspace } from "./use-run-workspace";
import { WorkspaceHeader } from "./WorkspaceHeader";
import "../scope.css";
import "./workspace.css";

export interface WorkspaceProps {
  task: Task;
  project: Project;
  /** 要顯示的 Run；還沒有執行時為 null。 */
  run: Run | null;
  initialTab: WorkspaceTab | undefined;
  focus: string | undefined;
}

/** 工作區的分頁、面板與跨區塊的操作（開檔案、編輯 prompt、跳到事件）。 */
function useWorkspaceUi(initialTab: WorkspaceTab | undefined) {
  const panel = usePanel();
  const [tab, setTab] = useState<WorkspaceTab>(initialTab ?? "task");
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [panelFocus, setPanelFocus] = useState<string | null>(null);
  const { setOpen } = panel;
  // 深連結指定了分頁時打開面板
  useEffect(() => {
    if (initialTab) setOpen(true);
  }, [initialTab, setOpen]);
  const openTab = useCallback(
    (next: WorkspaceTab, focus?: string) => {
      setTab(next);
      setPanelFocus(focus ?? null);
      setOpen(true);
    },
    [setOpen],
  );
  return { panel, tab, setTab, diffPath, setDiffPath, panelFocus, openTab };
}

export function Workspace({ task, project, run, initialTab, focus }: WorkspaceProps) {
  const [redispatching, setRedispatching] = useState(false);
  if (run && !redispatching) {
    return (
      <RunWorkspace
        key={run.id}
        task={task}
        project={project}
        run={run}
        initialTab={initialTab}
        focus={focus}
        onRedispatch={() => setRedispatching(true)}
      />
    );
  }
  return (
    <TaskOnlyWorkspace
      task={task}
      project={project}
      previousRun={run}
      initialTab={initialTab}
      focus={focus}
    />
  );
}

function useNeeds(taskId: string): boolean {
  const { data: needs = [] } = useQuery(needsYouQuery);
  return needs.some((item) => item.taskId === taskId);
}

function useOpenRun(task: Task) {
  const navigate = useNavigate();
  return (run: Run) =>
    void navigate({
      to: "/tasks/$taskKey",
      params: { taskKey: task.key },
      search: { run: run.id },
    });
}

// ---------- 有 Run ----------

function RunWorkspace({
  task,
  project,
  run,
  initialTab,
  focus,
  onRedispatch,
}: Omit<WorkspaceProps, "run"> & { run: Run; onRedispatch: () => void }) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const ui = useWorkspaceUi(initialTab);
  const data = useRunWorkspace(run, task, project);
  const { autoExpandTools } = usePreferences();
  const { data: members = [] } = useQuery(membersQuery);
  const { data: criteria = [] } = useQuery(acceptanceCriteriaQuery(task.id));
  const { data: runs = [] } = useQuery(taskRunsQuery(task.id));
  const needs = useNeeds(task.id);
  const expansion = useExpansion();
  const now = useNow(30_000);
  const [text, setText] = useState("");
  const [focusSignal, setFocusSignal] = useState(0);
  const [focusKey, setFocusKey] = useState<string | null>(
    focus && focus !== "verification" ? focus : null,
  );
  const items = data.timeline.items;
  const { status, gate } = data;
  const context = useMemo(
    () => ({ status, gate, autoExpandTools }),
    [status, gate, autoExpandTools],
  );
  const stream = useMemo(() => buildStream(items, context), [items, context]);
  const shown = useMemo(
    () => withExtras(stream, data.settings?.changes ?? [], data.pullRequest),
    [stream, data.settings, data.pullRequest],
  );
  const tail = streamTail(stream, context, items);
  const pendingPermission: PendingPermission | null = useMemo(() => {
    const entry = stream.find((s) => s.kind === "permission" && s.item.resolved === null);
    return entry?.kind === "permission"
      ? { key: entry.key, title: entry.item.title, detail: entry.detail }
      : null;
  }, [stream]);
  const changedPaths = useMemo(
    () => changedPathsOf(items, data.reviewDiff?.files ?? []),
    [items, data.reviewDiff],
  );
  const diffFiles = data.reviewDiff?.files ?? [];
  const stats = useDiffStats(diffFiles);
  const terminal = (TERMINAL_RUN_STATUSES as readonly string[]).includes(data.status);

  const cancel = useMutation({
    mutationFn: async () => {
      // 在 Gate 中止：以 Gate 的 abort 決定送出（Task 回到 Ready）
      const gate = data.reviewGate ?? data.planGate;
      if (gate) await decideGate(gate.id, { action: "abort" });
      else await cancelRun(run.id);
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.run(run.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.taskGates(task.id) }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      ]),
  });

  const withdraw = useMutation({
    mutationFn: (controlId: string) => withdrawRunPrompt(run.id, controlId),
    onError: (error) => toast.show(errorMessage(error)),
  });

  const copy = useCallback(
    (value: string) => {
      void navigator.clipboard?.writeText(value).then(
        () => toast.show(t.common.copied),
        () => undefined,
      );
    },
    [toast, t],
  );

  const env: StreamEnv = {
    run,
    members: new Map(members.map((m) => [m.id, m])),
    settings: data.settings,
    criteria: new Map(criteria.map((c) => [c.id, c])),
    changedPaths,
    policy: data.settings?.current.permissionPolicy ?? run.permissionPolicy,
    now,
    pendingPlanSeq:
      data.planGate?.planSeq ??
      (data.status === "awaiting_gate" && data.gate === "plan"
        ? (items.findLast((i) => i.type === "plan_proposed")?.seq ?? null)
        : null),
    focusKey,
    ...expansion,
    ...data.controls,
    openFile: (path) => {
      ui.setDiffPath(path);
      ui.openTab("diff");
    },
    copy,
    editPrompt: (value) => {
      setText(value);
      setFocusSignal((n) => n + 1);
    },
    withdrawPrompt: data.permissions.can("run.control")
      ? (controlId) => withdraw.mutate(controlId)
      : null,
  };

  const lastPreview = [...items]
    .reverse()
    .find((i) => i.type === "preview_ready" || i.type === "preview_stopped");
  const badges: TabBadges = {
    diff: diffFiles.length > 0 ? { count: diffFiles.length, warn: data.reviewGate !== null } : null,
    preview: !terminal && lastPreview?.type === "preview_ready",
  };
  const canDispatch =
    data.permissions.can("run.dispatchLocal") || data.permissions.can("run.dispatchTeam");

  return (
    <WorkspaceLayout
      header={
        <WorkspaceHeader
          task={task}
          run={run}
          status={data.status}
          gate={data.gate}
          needs={needs}
          canCancel={!terminal && data.permissions.can("run.control")}
          cancelling={cancel.isPending}
          onCancel={() => cancel.mutate()}
          canRedispatch={
            terminal && data.status !== "completed" && task.status === "ready" && canDispatch
          }
          onRedispatch={onRedispatch}
          panelOpen={ui.panel.open}
          onTogglePanel={ui.panel.toggle}
        />
      }
      panel={
        <RightPanel tab={ui.tab} onTab={ui.setTab} badges={badges}>
          {ui.tab === "task" && (
            <TaskTab
              task={task}
              project={project}
              runs={runs}
              run={run}
              verifications={data.verifications}
              needs={needs}
              permissions={data.permissions}
              focus={ui.panelFocus ?? (focus === "verification" ? focus : null)}
            />
          )}
          {ui.tab === "diff" && (
            <DiffTab
              run={run}
              status={data.status}
              diff={data.reviewDiff}
              reviewGate={data.reviewGate}
              gates={data.gates}
              projectId={project.id}
              permissions={data.permissions}
              selectedPath={ui.diffPath}
              onSelectPath={ui.setDiffPath}
            />
          )}
          {/* 只在選取時掛載：Desktop 的內嵌瀏覽器在 PreviewPanel 卸載時才會隱藏 */}
          {ui.tab === "preview" && (
            <PreviewPanel
              runId={run.id}
              canComment={data.permissions.can("gate.reject")}
              canRestart={data.permissions.can("run.control")}
              canInvite={data.permissions.can("task.edit")}
            />
          )}
          {ui.tab === "terminal" && (
            <TerminalTab run={run} items={items} canOpen={data.permissions.can("run.control")} />
          )}
        </RightPanel>
      }
    >
      <ErrorText error={data.error ?? cancel.error} />
      <StreamProvider env={env}>
        <EventStream
          items={shown}
          tail={tail}
          loading={!data.connected && items.length === 0}
          dockShown={
            pendingPermission !== null || data.reviewGate !== null || data.planGate !== null
          }
        />
      </StreamProvider>
      <Composer
        run={run}
        task={task}
        project={project}
        data={data}
        pendingPermission={pendingPermission}
        reviewStats={diffFiles.length > 0 ? { files: diffFiles.length, ...stats } : null}
        text={text}
        onTextChange={setText}
        focusSignal={focusSignal}
        onJumpTo={(key) => {
          setFocusKey(null);
          requestAnimationFrame(() => setFocusKey(key));
        }}
        onOpenTab={(tab, panelFocus) => ui.openTab(tab, panelFocus)}
      />
    </WorkspaceLayout>
  );
}

/** 訊息中的檔名可以連到的檔案：review diff 的檔案、run_diff 與 tool call 的 diff 中的路徑。 */
function changedPathsOf(
  items: readonly TimelineItem[],
  files: readonly { path: string }[],
): string[] {
  const paths = new Set(files.map((f) => f.path));
  for (const item of items) {
    if (item.type === "run_diff") for (const path of item.paths) paths.add(path);
    if (item.type === "tool_call") {
      for (const content of item.content) if (content.type === "diff") paths.add(content.path);
    }
  }
  return [...paths];
}

// ---------- 還沒有 Run ----------

function TaskOnlyWorkspace({
  task,
  project,
  previousRun,
  initialTab,
  focus,
}: Omit<WorkspaceProps, "run"> & { previousRun: Run | null }) {
  const t = useT();
  const ui = useWorkspaceUi(initialTab);
  const permissions = usePermissions(project, task);
  const needs = useNeeds(task.id);
  const openRun = useOpenRun(task);
  const { data: runs = [] } = useQuery(taskRunsQuery(task.id));
  const empty = (text: string): ReactNode => <div className="wk-panel-empty">{text}</div>;

  return (
    <WorkspaceLayout
      header={
        <WorkspaceHeader
          task={task}
          run={null}
          status={null}
          gate={null}
          needs={needs}
          canCancel={false}
          cancelling={false}
          onCancel={() => undefined}
          canRedispatch={false}
          onRedispatch={() => undefined}
          panelOpen={ui.panel.open}
          onTogglePanel={ui.panel.toggle}
        />
      }
      panel={
        <RightPanel tab={ui.tab} onTab={ui.setTab} badges={{ diff: null, preview: false }}>
          {ui.tab === "task" && (
            <TaskTab
              task={task}
              project={project}
              runs={runs}
              run={previousRun}
              verifications={[]}
              needs={needs}
              permissions={permissions}
              focus={focus ?? null}
            />
          )}
          {ui.tab === "diff" && empty(t.workspace.diff.noDiff)}
          {ui.tab === "preview" && empty(t.workspace.preview.notStarted)}
          {ui.tab === "terminal" && <TerminalTab run={null} items={[]} />}
        </RightPanel>
      }
    >
      <NoRunView task={task} project={project} permissions={permissions} onDispatched={openRun} />
    </WorkspaceLayout>
  );
}
