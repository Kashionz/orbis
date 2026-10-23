import { getDesktopBridge } from "@orbis/desktop/bridge";
import { TERMINAL_RUN_STATUSES } from "@orbis/protocol";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  cancelRun,
  projectsQuery,
  queryKeys,
  runQuery,
  taskGatesQuery,
  taskQuery,
} from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { formatUsage, toRunUsage } from "../../lib/format";
import {
  DELEGATION_MODE_LABELS,
  PERMISSION_POLICY_LABELS,
  RUN_ORIGIN_LABELS,
  RUN_STATUS_LABELS,
  RUNNER_KIND_LABELS,
} from "../../lib/labels";
import { usePermissions } from "../auth/use-permissions";
import { PlanGatePanel } from "../gate/PlanGatePanel";
import { VerificationPanel } from "../verification/VerificationPanel";
import { useRunControls } from "./use-run-controls";
import { useRunTimeline } from "./use-run-timeline";
import { VirtualTimeline } from "./VirtualTimeline";

type RunTab = "timeline" | "verification";

/**
 * Run 即時檢視：時間軸、Verification 結果、等待中的 Plan Gate。`focus` 是要捲到的時間軸項目 key。
 */
export function RunPage({ runId, focus }: { runId: string; focus: string | undefined }) {
  const queryClient = useQueryClient();
  const { data: run } = useSuspenseQuery(runQuery(runId));
  const { data: task } = useQuery(taskQuery(run.taskId));
  const { data: projects = [] } = useQuery(projectsQuery);
  const { data: gates = [] } = useQuery(taskGatesQuery(run.taskId));
  const project = projects.find((p) => p.id === task?.projectId);
  const permissions = usePermissions(project, task);
  const { timeline, connected, error: streamError } = useRunTimeline(runId);
  const [tab, setTab] = useState<RunTab>("timeline");

  const status = timeline.status ?? run.status;
  const usage = timeline.usage ? toRunUsage(timeline.usage) : run.usage;
  const terminal = (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
  // 協定先送 awaiting_gate(review) 再開始 Verification，所以看是否有待決定的 Review Gate，不看 Run 狀態
  const awaitingReview = gates.some(
    (g) => g.runId === runId && g.kind === "review" && g.decision === null,
  );
  const planGate =
    gates.find((g) => g.runId === runId && g.kind === "plan" && g.decision === null) ?? null;
  const verificationEvents = timeline.items.filter(
    (i) => i.type === "verification_result" || i.type === "verification_completed",
  ).length;

  // 每收到一筆 Verification 的 Event，就重新取得保存的結果
  useEffect(() => {
    if (verificationEvents === 0) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.verifications(runId) });
  }, [verificationEvents, queryClient, runId]);

  // 狀態改變時，Run、Task 與 Needs You 的資料也跟著變了
  useEffect(() => {
    if (timeline.status === null) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) });
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.needsYou });
  }, [timeline.status, queryClient, runId]);

  const cancel = useMutation({ mutationFn: () => cancelRun(runId) });
  const { controls, error: respondError } = useRunControls(run, permissions);

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
            {run.origin !== "dispatch" && (
              <span className="tag">{RUN_ORIGIN_LABELS[run.origin]}</span>
            )}
            {run.delegationMode && (
              <span className="tag">{DELEGATION_MODE_LABELS[run.delegationMode]}</span>
            )}
            {run.parentRunId && (
              <Link to="/runs/$runId" params={{ runId: run.parentRunId }}>
                父 Run
              </Link>
            )}
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
      {run.worktreePath && <DesktopActions worktreePath={run.worktreePath} />}
      <ErrorText error={streamError ?? respondError ?? cancel.error} />
      {planGate && (
        <PlanGatePanel
          gate={planGate}
          runId={runId}
          canApprove={permissions.can("gate.approve")}
          canReject={permissions.can("gate.reject")}
          canAbort={permissions.can("run.control")}
        />
      )}
      <div className="tabs run-tabs" role="tablist" aria-label="Run 的內容">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "timeline"}
          onClick={() => setTab("timeline")}
        >
          時間軸
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "verification"}
          onClick={() => setTab("verification")}
        >
          Verification
        </button>
      </div>
      {tab === "timeline" && (
        <VirtualTimeline items={timeline.items} controls={controls} focusKey={focus} />
      )}
      {tab === "verification" && (
        <VerificationPanel
          runId={runId}
          taskId={run.taskId}
          maxRetries={project?.policy.verificationMaxRetries ?? 3}
          canDecide={permissions.can("run.control")}
        />
      )}
    </main>
  );
}

/**
 * 在 Desktop 中執行時，提供用編輯器或終端機開啟 Worktree（ARCHITECTURE §16.1）。
 * 一般瀏覽器沒有 bridge，不顯示。
 */
export function DesktopActions({ worktreePath }: { worktreePath: string }) {
  const [bridge] = useState(() => getDesktopBridge());
  const open = useMutation({
    mutationFn: async (target: "editor" | "terminal") => {
      if (!bridge) return;
      const result =
        target === "editor"
          ? await bridge.openWorktreeInEditor(worktreePath)
          : await bridge.openWorktreeInTerminal(worktreePath);
      if (!result.ok) throw new Error(result.message);
    },
  });
  if (!bridge) return null;
  return (
    <div className="desktop-actions">
      <button type="button" disabled={open.isPending} onClick={() => open.mutate("editor")}>
        用編輯器開啟 Worktree
      </button>
      <button type="button" disabled={open.isPending} onClick={() => open.mutate("terminal")}>
        在終端機開啟
      </button>
      <ErrorText error={open.error} />
    </div>
  );
}
