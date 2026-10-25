// 工作區路由渲染的頁面（router.tsx 只呼叫這裡）。
// `/runs/$runId` 與 `/runs/$runId/review` 是深連結（Desktop 桌面通知、待我處理、通知中心），原地渲染
// 同一個工作區。

import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  projectsQuery,
  runQuery,
  taskByKeyQuery,
  taskQuery,
  taskRunsQuery,
} from "../../api/resources";
import { useT } from "../../i18n";
import type { RunLinkSearch, TaskWorkspaceSearch } from "../shell/workspace-search";
import { pickRun, runRouteView } from "./workspace/route-state";
import { Workspace } from "./workspace/Workspace";

function useProject(projectId: string) {
  const t = useT();
  const { data: projects } = useSuspenseQuery(projectsQuery);
  const project = projects.find((p) => p.id === projectId);
  if (!project) throw new Error(t.workspace.header.loadFailed);
  return project;
}

/** `/tasks/$taskKey`：Task 的工作區。`run` 指定要看的 Run，省略時看最新的主 Run。 */
export function TaskWorkspaceRoute({
  taskKey,
  run,
  tab,
  focus,
}: { taskKey: string } & TaskWorkspaceSearch) {
  const { data: task } = useSuspenseQuery(taskByKeyQuery(taskKey));
  const project = useProject(task.projectId);
  const { data: runs } = useSuspenseQuery(taskRunsQuery(task.id));
  const selected = pickRun(runs, run);
  return (
    <Workspace
      key={selected?.id ?? "none"}
      task={task}
      project={project}
      run={selected}
      initialTab={tab}
      focus={focus}
    />
  );
}

/** `/runs/$runId`：深連結開啟某個 Run。 */
export function RunRoute({ runId, focus, tab }: { runId: string } & RunLinkSearch) {
  return <RunLink runId={runId} view={runRouteView("run", { focus, tab })} />;
}

/** `/runs/$runId/review`：Review Gate 的 diff（工作區的差異分頁）。 */
export function RunReviewRoute({ runId }: { runId: string }) {
  return <RunLink runId={runId} view={runRouteView("review", {})} />;
}

function RunLink({ runId, view }: { runId: string; view: ReturnType<typeof runRouteView> }) {
  const { data: run } = useSuspenseQuery(runQuery(runId));
  const { data: task } = useSuspenseQuery(taskQuery(run.taskId));
  const project = useProject(task.projectId);
  // 預先取得 Run 歷史，Task 分頁打開時不必等
  useQuery(taskRunsQuery(task.id));
  return (
    <Workspace task={task} project={project} run={run} initialTab={view.tab} focus={view.focus} />
  );
}
