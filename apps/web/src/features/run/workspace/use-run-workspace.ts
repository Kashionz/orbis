// 工作區中一個 Run 的資料：即時時間軸、Gate、Verification、review diff、後端缺口的資料，
// 以及狀態改變時要重新取得的資料。

import type { Gate, Project, Run, Task } from "@orbis/api-contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  queryKeys,
  reviewDiffQuery,
  taskGatesQuery,
  verificationsQuery,
} from "../../../api/resources";
import { isFeatureEnabled } from "../../../lib/features";
import { toRunUsage } from "../../../lib/format";
import { usePermissions } from "../../auth/use-permissions";
import { useRunControls } from "../use-run-controls";
import { useRunTimeline } from "../use-run-timeline";
import {
  eventActorsQuery,
  runSettingsQuery,
  taskPullRequestQuery,
  workspaceKeys,
} from "../workspace-api";

function pendingGate(gates: readonly Gate[], runId: string, kind: Gate["kind"]): Gate | null {
  return gates.find((g) => g.runId === runId && g.kind === kind && g.decision === null) ?? null;
}

export function useRunWorkspace(run: Run, task: Task, project: Project) {
  const queryClient = useQueryClient();
  const permissions = usePermissions(project, task);
  const { timeline, connected, error: streamError } = useRunTimeline(run.id);
  const { controls, error: respondError } = useRunControls(run, permissions);

  const status = timeline.status ?? run.status;
  const gate = status === "awaiting_gate" ? timeline.gate : null;
  const usage = timeline.usage ? toRunUsage(timeline.usage) : run.usage;

  const { data: gates = [] } = useQuery(taskGatesQuery(task.id));
  const planGate = pendingGate(gates, run.id, "plan");
  const reviewGate = pendingGate(gates, run.id, "review");

  const { data: verifications = [] } = useQuery({
    ...verificationsQuery(run.id),
    // 進行中時持續更新（結果由 verification_result Event 逐條寫入）
    refetchInterval: (query) =>
      query.state.data?.some((v) => v.status === "running") ? 2_000 : false,
  });
  const verificationAwaitingDecision = verifications.at(-1)?.awaitingDecision ?? false;

  const diffEvents = timeline.items.filter((i) => i.type === "run_diff").length;
  const reviewDiff = useQuery({ ...reviewDiffQuery(run.id), enabled: diffEvents > 0 });

  // TODO(backend, run-settings／event-actor／task-pull-request)：後端有 API 之前真實模式不取得
  const settings = useQuery({
    ...runSettingsQuery(run.id),
    enabled: isFeatureEnabled("runSettings"),
  });
  const actors = useQuery({
    ...eventActorsQuery(run.id),
    enabled: isFeatureEnabled("eventActors"),
  });
  const pullRequest = useQuery({
    ...taskPullRequestQuery(task.id),
    enabled:
      isFeatureEnabled("taskPullRequest") && (task.status === "pr_open" || task.status === "done"),
  });

  const verificationEvents = timeline.items.filter(
    (i) => i.type === "verification_result" || i.type === "verification_completed",
  ).length;
  const promptEvents = timeline.items.filter(
    (i) => i.type === "prompt" || (i.type === "permission" && i.resolved !== null),
  ).length;

  // 每收到一筆 Verification 的 Event，就重新取得保存的結果
  useEffect(() => {
    if (verificationEvents === 0) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.verifications(run.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.acceptanceCriteria(task.id) });
  }, [verificationEvents, queryClient, run.id, task.id]);

  // 新的 run_diff：review diff 換成最新的一份
  useEffect(() => {
    if (diffEvents === 0) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.reviewDiff(run.id) });
  }, [diffEvents, queryClient, run.id]);

  useEffect(() => {
    if (promptEvents === 0 || !isFeatureEnabled("eventActors")) return;
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.eventActors(run.id) });
  }, [promptEvents, queryClient, run.id]);

  // 狀態（含等待的 Gate）改變時，Run、Task、Gate 與待我處理的資料也跟著變了
  const statusKey = timeline.status === null ? null : `${timeline.status}:${timeline.gate ?? ""}`;
  useEffect(() => {
    if (statusKey === null) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.run(run.id) });
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskGates(task.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.needsYou });
    void queryClient.invalidateQueries({ queryKey: ["projects", task.projectId, "tasks"] });
  }, [statusKey, queryClient, run.id, task.id, task.projectId]);

  return {
    permissions,
    controls,
    timeline,
    connected,
    status,
    gate,
    usage,
    gates,
    planGate,
    reviewGate,
    verifications,
    verificationAwaitingDecision,
    reviewDiff: reviewDiff.data ?? null,
    settings: settings.data ?? null,
    actors: actors.data ?? null,
    pullRequest: pullRequest.data ?? null,
    error: streamError ?? respondError ?? reviewDiff.error ?? null,
  };
}

export type RunWorkspaceData = ReturnType<typeof useRunWorkspace>;
