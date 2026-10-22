import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { taskRunsQuery } from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { formatTime, formatUsage } from "../../lib/format";
import { RUN_STATUS_LABELS, RUNNER_KIND_LABELS } from "../../lib/labels";

/** Task 的 Run 歷史（新的在前），點擊進入 Run 即時檢視。 */
export function RunHistory({ taskId }: { taskId: string }) {
  const { data: runs = [], error } = useQuery(taskRunsQuery(taskId));
  return (
    <section className="section" aria-labelledby="runs-heading">
      <h2 id="runs-heading">Run 歷史</h2>
      <ErrorText error={error} />
      {runs.length === 0 ? (
        <p className="empty">還沒有 Run</p>
      ) : (
        <table className="run-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Agent</th>
              <th>在哪裡跑</th>
              <th>Permission Policy</th>
              <th>狀態</th>
              <th>用量</th>
              <th>建立時間</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} data-run-id={run.id}>
                <td>
                  <Link to="/runs/$runId" params={{ runId: run.id }}>
                    {run.id}
                  </Link>
                </td>
                <td>
                  {run.agent}
                  {run.model && <span className="hint"> {run.model}</span>}
                </td>
                <td>{RUNNER_KIND_LABELS[run.runnerKind]}</td>
                <td>{run.permissionPolicy}</td>
                <td>
                  <span className="status-badge" data-status={run.status}>
                    {RUN_STATUS_LABELS[run.status]}
                  </span>
                </td>
                <td>{formatUsage(run.usage)}</td>
                <td>{formatTime(run.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
