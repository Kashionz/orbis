import { canTransitionManually, type Task, type TaskStatus } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { acceptanceCriteriaQuery, queryKeys, transitionTask } from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { useT } from "../../i18n";
import { missingReadyRequirements, readyChecklist } from "../../lib/ready";

/**
 * Task 頁的 Ready 檢查（#59）：Backlog 時列出進入 Ready 還缺什麼，並提供手動轉換的按鈕
 * （看板拖曳以外的另一個入口，轉換規則同 `MANUAL_TASK_TRANSITIONS`）。
 */
export function ReadyPanel({ task, canEdit }: { task: Task; canEdit: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: criteria = [] } = useQuery(acceptanceCriteriaQuery(task.id));
  const checks = readyChecklist(task, criteria.length);
  const missing = missingReadyRequirements(checks);
  const transition = useMutation({
    mutationFn: (status: TaskStatus) => transitionTask(task.id, status),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.taskByKey(updated.key), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks(updated.projectId) });
    },
  });

  if (task.status !== "backlog" && task.status !== "ready") return null;
  const toReady = task.status === "backlog";
  const target: TaskStatus = toReady ? "ready" : "backlog";

  return (
    <section className="ready-panel" aria-labelledby="ready-heading">
      <h2 id="ready-heading">{toReady ? "進入 Ready 的條件" : "已進入 Ready"}</h2>
      {toReady && (
        <ul className="ready-checklist">
          {checks.map((check) => (
            <li key={check.requirement} data-met={String(check.met)}>
              <span aria-hidden="true">{check.met ? "✓" : "✗"}</span>{" "}
              {t.labels.readyRequirement[check.requirement]}
              <span className="visually-hidden">{check.met ? "（已完成）" : "（還缺）"}</span>
            </li>
          ))}
        </ul>
      )}
      {canEdit && canTransitionManually(task.status, target) && (
        <button
          type="button"
          className={toReady ? "primary" : undefined}
          disabled={transition.isPending || (toReady && missing.length > 0)}
          onClick={() => transition.mutate(target)}
        >
          {toReady ? "移到 Ready" : "移回 Backlog"}
        </button>
      )}
      {toReady && missing.length > 0 && (
        <p className="hint">還缺：{missing.map((m) => t.labels.readyRequirement[m]).join("、")}</p>
      )}
      <ErrorText error={transition.error} />
    </section>
  );
}
