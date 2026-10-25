// 工作區中一個 Run 的資料：即時時間軸、Gate、Verification、review diff、Run 的設定與 PR，
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
import { toRunUsage } from "../../../lib/format";
import { usePermissions } from "../../auth/use-permissions";
import { boardSummaryKey } from "../../board/api";
import { useRunControls } from "../use-run-controls";
import { useRunTimeline } from "../use-run-timeline";
import { runSettingsQuery, workspaceKeys } from "../workspace-api";

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

  // 停在 Gate 但還沒取得那個 Gate 時（Gate 比 Event 晚到），短暫輪詢到出現為止
  const { data: gates = [] } = useQuery({
    ...taskGatesQuery(task.id),
    refetchInterval: (query) =>
      status === "awaiting_gate" &&
      gate !== null &&
      pendingGate(query.state.data ?? [], run.id, gate) === null
        ? 1_000
        : false,
  });
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

  const settings = useQuery(runSettingsQuery(run.id));

  const verificationEvents = timeline.items.filter(
    (i) => i.type === "verification_result" || i.type === "verification_completed",
  ).length;

  // 每收到一筆 Verification 的 Event，就重新取得保存的結果
  useEffect(() => {
    if (verificationEvents === 0) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.verifications(run.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.acceptanceCriteria(task.id) });
    void queryClient.invalidateQueries({ queryKey: boardSummaryKey(task.projectId) });
  }, [verificationEvents, queryClient, run.id, task.id, task.projectId]);

  // 新的 run_diff：review diff 換成最新的一份
  useEffect(() => {
    if (diffEvents === 0) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.reviewDiff(run.id) });
  }, [diffEvents, queryClient, run.id]);

  // 模型、推理強度、權限策略的切換或換 Agent 生效：重新取得 Run 的設定（與 Run 的 Agent、模型）
  const settingsVersion = timeline.settingsVersion;
  useEffect(() => {
    if (settingsVersion === 0) return;
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.runSettings(run.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.run(run.id) });
  }, [settingsVersion, queryClient, run.id]);

  // 狀態（含等待的 Gate）改變時，Run、Task、Gate 與待我處理的資料也跟著變了
  const statusKey = timeline.status === null ? null : `${timeline.status}:${timeline.gate ?? ""}`;
  useEffect(() => {
    if (statusKey === null) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.run(run.id) });
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskGates(task.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.needsYou });
    void queryClient.invalidateQueries({ queryKey: ["projects", task.projectId, "tasks"] });
    void queryClient.invalidateQueries({ queryKey: boardSummaryKey(task.projectId) });
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
    pullRequest: task.pullRequest,
    error: streamError ?? respondError ?? reviewDiff.error ?? null,
  };
}

export type RunWorkspaceData = ReturnType<typeof useRunWorkspace>;
