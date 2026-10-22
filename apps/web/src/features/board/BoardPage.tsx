import { TASK_STATUSES, type TaskStatus } from "@orbis/api-contract";

/** 看板欄位標題，沿用 ARCHITECTURE §5 的狀態名稱。 */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  planning: "Planning",
  plan_gate: "Plan Gate",
  running: "Running",
  verifying: "Verifying",
  review_gate: "Review Gate",
  pr_open: "PR Open",
  done: "Done",
};

// TODO(api): B 軌提供 Task API 後依 Project 載入 Task
export function BoardPage() {
  return (
    <main className="board">
      {TASK_STATUSES.map((status) => (
        <section
          key={status}
          className="board-column"
          data-status={status}
          aria-labelledby={`column-${status}`}
        >
          <h2 id={`column-${status}`}>{TASK_STATUS_LABELS[status]}</h2>
          <p className="empty">沒有 Task</p>
        </section>
      ))}
    </main>
  );
}
