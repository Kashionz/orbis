import type { Run } from "@orbis/api-contract";
import { TERMINAL_RUN_STATUSES } from "@orbis/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { cancelRun, queryKeys, taskRunsQuery } from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { useT } from "../../i18n";
import { formatTime, formatUsage, toRunUsage } from "../../lib/format";
import { buildRunTree, flattenRunTree, type RunNode } from "../../lib/run-tree";
import type { Permissions } from "../auth/use-permissions";
import { useRunControls } from "../run/use-run-controls";
import { useRunTimeline } from "../run/use-run-timeline";
import { VirtualTimeline } from "../run/VirtualTimeline";

const isTerminal = (run: Run) => (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status);

/**
 * Task 的 Run 與 Child Run（ARCHITECTURE §9「UI」）：樹狀顯示 Agent、model、狀態、用量，
 * 可以單獨中止任一節點；選取節點後在下方顯示那個 Run 的即時時間軸。
 */
export function RunTree({ taskId, permissions }: { taskId: string; permissions: Permissions }) {
  const { data: runs = [], error } = useQuery(taskRunsQuery(taskId));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const tree = buildRunTree(runs);
  const selected = flattenRunTree(tree).find((n) => n.run.id === selectedId)?.run ?? null;

  return (
    <section className="section" aria-labelledby="runs-heading">
      <h2 id="runs-heading">Run 與 Child Run</h2>
      <ErrorText error={error} />
      {runs.length === 0 ? (
        <p className="empty">還沒有 Run</p>
      ) : (
        <ul className="run-tree" aria-label="Run 與 Child Run">
          {tree.map((node) => (
            <RunTreeNode
              key={node.run.id}
              node={node}
              selectedId={selectedId}
              onSelect={(id) => setSelectedId((current) => (current === id ? null : id))}
              canCancel={permissions.can("run.control")}
            />
          ))}
        </ul>
      )}
      {selected && <RunLiveView key={selected.id} run={selected} permissions={permissions} />}
    </section>
  );
}

function RunTreeNode({
  node,
  selectedId,
  onSelect,
  canCancel,
}: {
  node: RunNode;
  selectedId: string | null;
  onSelect: (runId: string) => void;
  canCancel: boolean;
}) {
  const t = useT();
  const { run } = node;
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => cancelRun(run.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.taskRuns(run.taskId) }),
  });
  const selected = selectedId === run.id;
  return (
    <li
      data-run-id={run.id}
      data-depth={node.depth}
      data-selected={String(selected)}
      className="run-node"
    >
      <div className="run-node-row">
        <button
          type="button"
          className="link-button run-node-select"
          aria-pressed={selected}
          onClick={() => onSelect(run.id)}
        >
          <code>{run.id}</code>
        </button>
        {run.origin !== "dispatch" && <span className="tag">{t.labels.runOrigin[run.origin]}</span>}
        {run.delegationMode && (
          <span className="tag">{t.labels.delegationMode[run.delegationMode]}</span>
        )}
        <span className="run-node-agent">
          {run.agent}
          {run.model && <span className="hint"> {run.model}</span>}
        </span>
        <span className="status-badge" data-status={run.status}>
          {t.labels.runStatus[run.status]}
        </span>
        <span className="hint run-node-usage">{formatUsage(run.usage)}</span>
        <span className="hint">
          {t.labels.runnerKind[run.runnerKind]} · {formatTime(run.createdAt)}
        </span>
        <Link to="/runs/$runId" params={{ runId: run.id }}>
          開啟 Run 頁
        </Link>
        {canCancel && !isTerminal(run) && (
          <button
            type="button"
            className="danger"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            中止
          </button>
        )}
      </div>
      <ErrorText error={cancel.error} />
      {node.children.length > 0 && (
        <ul aria-label={`${run.id} 的 Child Run`}>
          {node.children.map((child) => (
            <RunTreeNode
              key={child.run.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
              canCancel={canCancel}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** 選取的節點的即時時間軸（訂閱它的 Event）。 */
function RunLiveView({ run, permissions }: { run: Run; permissions: Permissions }) {
  const t = useT();
  const { timeline, connected, error } = useRunTimeline(run.id);
  const { controls, error: respondError } = useRunControls(run, permissions);
  const status = timeline.status ?? run.status;
  const usage = timeline.usage ? toRunUsage(timeline.usage) : run.usage;
  return (
    <section className="run-live-view" aria-label={`Run ${run.id} 的即時檢視`}>
      <header className="run-live-header">
        <strong>
          {run.agent} <code>{run.id}</code>
        </strong>
        <span className="status-badge" data-status={status}>
          {t.labels.runStatus[status]}
        </span>
        <span className="hint">{formatUsage(usage)}</span>
        <span className="connection" data-connected={connected}>
          {connected ? "即時連線中" : "連線中…"}
        </span>
      </header>
      <ErrorText error={error ?? respondError} />
      <VirtualTimeline items={timeline.items} controls={controls} focusKey={undefined} />
    </section>
  );
}
