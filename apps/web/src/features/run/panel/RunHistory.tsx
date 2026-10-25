// Task 分頁的執行紀錄：Run 與 Child Run 的樹（ARCHITECTURE §9「UI」）。目前顯示的 Run 有底色；
// 點一列在工作區切換到那個 Run；還沒結束的 Run 可以單獨中止。

import type { Run } from "@orbis/api-contract";
import { TERMINAL_RUN_STATUSES } from "@orbis/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Square } from "lucide-react";
import { cancelRun, queryKeys } from "../../../api/resources";
import { ErrorText } from "../../../components/ErrorText";
import { useT } from "../../../i18n";
import { buildRunTree, flattenRunTree } from "../../../lib/run-tree";
import { runTone, TONE_COLOR } from "../run-tone";

interface RunHistoryProps {
  taskKey: string;
  runs: readonly Run[];
  currentRunId: string | null;
  canCancel: boolean;
}

const isTerminal = (run: Run) => (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status);

export function RunHistory({ taskKey, runs, currentRunId, canCancel }: RunHistoryProps) {
  const t = useT();
  const w = t.workspace.task;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: (runId: string) => cancelRun(runId),
    onSuccess: (run) => queryClient.invalidateQueries({ queryKey: queryKeys.taskRuns(run.taskId) }),
  });
  // 頂層的 Run 新的在上面，Child Run 接在父 Run 底下
  const roots = buildRunTree([...runs]).sort((a, b) =>
    b.run.createdAt.localeCompare(a.run.createdAt),
  );
  const list = roots.flatMap((root) => flattenRunTree([root]));

  return (
    <section className="rp-section" aria-labelledby="rp-runs-heading">
      <h2 id="rp-runs-heading" className="rp-section-title">
        {w.runs}
      </h2>
      {list.length === 0 && <span className="rp-muted">{w.noRuns}</span>}
      <ul className="rp-runs" aria-label={w.runs}>
        {list.map(({ run, depth }) => (
          <li
            key={run.id}
            className="rp-run"
            data-run-id={run.id}
            data-depth={depth}
            data-current={run.id === currentRunId}
            style={{ paddingLeft: 10 + depth * 16 }}
          >
            <button
              type="button"
              className="rp-run-open"
              aria-current={run.id === currentRunId ? "true" : undefined}
              onClick={() =>
                void navigate({
                  to: "/tasks/$taskKey",
                  params: { taskKey },
                  search: { run: run.id },
                })
              }
            >
              <span className="rp-mono-muted">{run.id}</span>
              <span className="rp-mono-muted rp-ellipsis">
                {run.agent}
                {run.model && ` ${run.model}`}
                {run.origin !== "dispatch" && ` ${t.labels.runOrigin[run.origin]}`}
                {run.delegationMode && ` ${t.labels.delegationMode[run.delegationMode]}`}
              </span>
              <span style={{ color: TONE_COLOR[runTone(run.status)] }}>
                {t.labels.runStatus[run.status]}
              </span>
            </button>
            {canCancel && !isTerminal(run) && (
              <button
                type="button"
                className="rp-icon-btn"
                data-danger="true"
                aria-label={`${w.cancelRun} ${run.id}`}
                data-tip={w.cancelRun}
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(run.id)}
              >
                <Square size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <ErrorText error={cancel.error} />
    </section>
  );
}
