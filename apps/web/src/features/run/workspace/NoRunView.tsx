// 還沒有執行（或要重新派工）時的主欄：進入就緒前還缺少的項目、依賴未完成、派工表單。
// 待辦與就緒之間的手動轉換也在這裡（原本 Task 頁的 Ready 檢查）。

import {
  canTransitionManually,
  type Project,
  type Run,
  type Task,
  type TaskStatus,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  acceptanceCriteriaQuery,
  queryKeys,
  tasksQuery,
  transitionTask,
} from "../../../api/resources";
import { ErrorText } from "../../../components/ErrorText";
import { useT } from "../../../i18n";
import { unfinishedDependencies } from "../../../lib/dependencies";
import { missingReadyRequirements, readyChecklist } from "../../../lib/ready";
import type { Permissions } from "../../auth/use-permissions";
import { DispatchForm } from "../../dispatch/DispatchForm";

interface NoRunViewProps {
  task: Task;
  project: Project;
  permissions: Permissions;
  onDispatched: (run: Run) => void;
}

export function NoRunView({ task, project, permissions, onDispatched }: NoRunViewProps) {
  const t = useT();
  const n = t.workspace.noRun;
  const queryClient = useQueryClient();
  const { data: criteria = [] } = useQuery(acceptanceCriteriaQuery(task.id));
  const { data: projectTasks = [] } = useQuery(tasksQuery(project.id));
  const checks = readyChecklist(task, criteria.length);
  const missing = missingReadyRequirements(checks);
  const blockers = unfinishedDependencies(task, projectTasks);
  const canEdit = permissions.can("task.edit");
  const canDispatch = permissions.can("run.dispatchLocal") || permissions.can("run.dispatchTeam");
  const transition = useMutation({
    mutationFn: (status: TaskStatus) => transitionTask(task.id, status),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.taskByKey(updated.key), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks(updated.projectId) });
    },
  });

  return (
    <div className="wk-norun">
      <div className="wk-norun-column">
        <h2 className="wk-norun-title">{n.title}</h2>
        {task.status === "backlog" && (
          <section className="wk-norun-section" aria-label={n.missing}>
            {missing.length > 0 && <span className="wk-muted">{n.missing}</span>}
            <ul className="wk-checklist">
              {checks.map((check) => (
                <li key={check.requirement} data-met={String(check.met)}>
                  <span className="wk-check-glyph" data-met={check.met} aria-hidden="true">
                    {check.met ? "✓" : "○"}
                  </span>
                  {t.labels.readyRequirement[check.requirement]}
                  <span className="visually-hidden">{check.met ? n.met : n.notMet}</span>
                </li>
              ))}
            </ul>
            {canEdit && canTransitionManually("backlog", "ready") && (
              <div>
                <button
                  type="button"
                  className="o-btn"
                  data-variant="primary"
                  disabled={transition.isPending || missing.length > 0}
                  onClick={() => transition.mutate("ready")}
                >
                  {n.moveToReady}
                </button>
              </div>
            )}
          </section>
        )}
        {task.status === "ready" && blockers.length > 0 && (
          <span className="wk-muted" role="note">
            {n.blockedPrefix}{" "}
            <span className="wk-mono">{blockers.map((b) => b.key).join(" ")}</span>{" "}
            {n.blockedSuffix}
          </span>
        )}
        {task.status === "ready" && blockers.length === 0 && canDispatch && (
          <DispatchForm task={task} project={project} onDispatched={onDispatched} />
        )}
        {task.status === "ready" && !canDispatch && (
          <span className="wk-muted">{n.noPermission}</span>
        )}
        {task.status === "ready" && canEdit && (
          <div>
            <button
              type="button"
              className="o-btn"
              data-variant="ghost"
              disabled={transition.isPending}
              onClick={() => transition.mutate("backlog")}
            >
              {n.moveToBacklog}
            </button>
          </div>
        )}
        <ErrorText error={transition.error} />
      </div>
    </div>
  );
}
