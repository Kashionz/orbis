import { TERMINAL_RUN_STATUSES } from "@orbis/protocol";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  cancelRun,
  projectsQuery,
  queryKeys,
  respondToPermission,
  runQuery,
  taskQuery,
} from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { formatUsage, toRunUsage } from "../../lib/format";
import { PERMISSION_POLICY_LABELS, RUN_STATUS_LABELS, RUNNER_KIND_LABELS } from "../../lib/labels";
import { canRespondToPermission } from "../../lib/permissions";
import { usePermissions } from "../auth/use-permissions";
import type { ItemControls } from "./TimelineItemView";
import { useRunTimeline } from "./use-run-timeline";
import { VirtualTimeline } from "./VirtualTimeline";

/** Run 即時檢視（交付 4）。`focus` 是要捲到的時間軸項目 key。 */
export function RunPage({ runId, focus }: { runId: string; focus: string | undefined }) {
  const queryClient = useQueryClient();
  const { data: run } = useSuspenseQuery(runQuery(runId));
  const { data: task } = useQuery(taskQuery(run.taskId));
  const { data: projects = [] } = useQuery(projectsQuery);
  const project = projects.find((p) => p.id === task?.projectId);
  const permissions = usePermissions(project, task);
  const { timeline, connected, error: streamError } = useRunTimeline(runId);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const status = timeline.status ?? run.status;
  const usage = timeline.usage ? toRunUsage(timeline.usage) : run.usage;
  const terminal = (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
  const awaitingReview = status === "awaiting_gate" && timeline.gate === "review";

  // 狀態改變時，Run、Task 與 Needs You 的資料也跟著變了
  useEffect(() => {
    if (timeline.status === null) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) });
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.needsYou });
  }, [timeline.status, queryClient, runId]);

  const respond = useMutation({
    mutationFn: ({ requestId, optionId }: { requestId: string; optionId: string }) =>
      respondToPermission(runId, { permissionRequestId: requestId, optionId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.needsYou }),
  });
  const cancel = useMutation({ mutationFn: () => cancelRun(runId) });

  const toggle = useCallback((key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const controls: ItemControls = {
    isExpanded: (key) => expanded.has(key),
    toggle,
    canRespond: canRespondToPermission(run, permissions.ctx),
    respondingRequestId: respond.isPending ? (respond.variables?.requestId ?? null) : null,
    respond: (requestId, optionId) => respond.mutate({ requestId, optionId }),
  };

  return (
    <main className="run-page">
      <header className="page-header run-header">
        <div>
          <nav className="breadcrumb">
            {task ? (
              <Link to="/tasks/$taskKey" params={{ taskKey: task.key }}>
                {task.key} {task.title}
              </Link>
            ) : (
              <span>Task</span>
            )}
          </nav>
          <h1>
            Run <code>{run.id}</code>
          </h1>
          <div className="run-meta">
            <span>{run.agent}</span>
            {run.model && <span>{run.model}</span>}
            <span>{RUNNER_KIND_LABELS[run.runnerKind]}</span>
            <span title={PERMISSION_POLICY_LABELS[run.permissionPolicy]}>
              {run.permissionPolicy}
            </span>
            {run.branch && <code>{run.branch}</code>}
          </div>
        </div>
        <span className="spacer" />
        <div className="run-status">
          <span className="status-badge" data-status={status} data-testid="run-status">
            {RUN_STATUS_LABELS[status]}
          </span>
          <span className="usage" data-testid="run-usage">
            {formatUsage(usage)}
          </span>
          <span className="connection" data-connected={connected}>
            {connected ? "即時連線中" : "連線中斷，重新連線中…"}
          </span>
        </div>
        {awaitingReview && (
          <Link to="/runs/$runId/review" params={{ runId }} className="button primary">
            Diff review
          </Link>
        )}
        {!terminal && permissions.can("run.control") && (
          <button
            type="button"
            className="danger"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            中止 Run
          </button>
        )}
      </header>
      <ErrorText error={streamError ?? respond.error ?? cancel.error} />
      <VirtualTimeline items={timeline.items} controls={controls} focusKey={focus} />
    </main>
  );
}
