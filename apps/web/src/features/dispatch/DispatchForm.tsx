// 派工表單（ARCHITECTURE §6.1、§8；README「還沒有執行」）：在哪裡跑、代理、模型、權限策略。
// 工作區還沒有執行時直接顯示；看板拖到執行中時放在對話框中。

import {
  type AgentOption,
  type DispatchOptions,
  type PermissionPolicy,
  type Project,
  RUNNER_KINDS,
  type Run,
  type RunnerKind,
  type Task,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Server } from "lucide-react";
import { useState } from "react";
import { dispatchOptionsQuery, dispatchRun, queryKeys, runnersQuery } from "../../api/resources";
import { AgentLogo } from "../../components/AgentLogo";
import { ErrorText } from "../../components/ErrorText";
import { Segmented } from "../../components/Segmented";
import { useT } from "../../i18n";
import {
  canDispatchTo,
  defaultPermissionPolicy,
  permissionPoliciesFor,
} from "../../lib/permissions";
import { modelDisplayName } from "../agents/catalog";
import { usePermissions } from "../auth/use-permissions";
import "./dispatch.css";

const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

interface DispatchFormProps {
  task: Task;
  project: Project;
  onDispatched: (run: Run) => void;
  /** 對話框中顯示取消鍵。 */
  onCancel?: () => void;
}

function firstAvailable(agents: readonly AgentOption[]): string {
  return agents.find((agent) => agent.available)?.id ?? "";
}

export function DispatchForm({ task, project, onDispatched, onCancel }: DispatchFormProps) {
  const t = useT();
  const { data: options, error, isPending } = useQuery(dispatchOptionsQuery(project.id));
  const { ctx } = usePermissions(project, task);
  if (isPending) return <p className="df-muted">{t.workspace.noRun.loadingAgents}</p>;
  if (error || !options) return <ErrorText error={error} />;
  const kinds = RUNNER_KINDS.filter((kind) => canDispatchTo(kind, ctx) && options[kind] !== null);
  if (kinds.length === 0) return <p className="df-muted">{t.workspace.noRun.noRunner}</p>;
  return (
    <DispatchFields
      task={task}
      options={options}
      kinds={kinds}
      onDispatched={onDispatched}
      onCancel={onCancel}
    />
  );
}

function DispatchFields({
  task,
  options,
  kinds,
  onDispatched,
  onCancel,
}: {
  task: Task;
  options: DispatchOptions;
  kinds: RunnerKind[];
  onDispatched: (run: Run) => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const n = t.workspace.noRun;
  const queryClient = useQueryClient();
  const initialKind = kinds[0] ?? "local";
  const [runnerKind, setRunnerKind] = useState<RunnerKind>(initialKind);
  const agents = options[runnerKind]?.agents ?? [];
  const [agentId, setAgentId] = useState(() => firstAvailable(options[initialKind]?.agents ?? []));
  const [model, setModel] = useState("");
  const [policy, setPolicy] = useState<PermissionPolicy>(() =>
    defaultPermissionPolicy(options.defaultPermissionPolicy, initialKind),
  );
  const agent = agents.find((a) => a.id === agentId && a.available);
  const { data: runners = [] } = useQuery({ ...runnersQuery, refetchInterval: false });
  const policies = permissionPoliciesFor(runnerKind);
  const me = usePermissions().ctx.memberId;

  const dispatch = useMutation({
    mutationFn: () =>
      dispatchRun(task.id, {
        agent: agentId,
        model: model === "" ? null : model,
        runnerKind,
        permissionPolicy: policy,
      }),
    onSuccess: async (run) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks(task.projectId) }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      ]);
      onDispatched(run);
    },
  });

  function changeRunnerKind(kind: RunnerKind) {
    setRunnerKind(kind);
    setAgentId(firstAvailable(options[kind]?.agents ?? []));
    setModel("");
    if (!permissionPoliciesFor(kind).includes(policy)) {
      setPolicy(defaultPermissionPolicy(options.defaultPermissionPolicy, kind));
    }
  }

  function hostOf(kind: RunnerKind): string | null {
    const runner = runners.find((r) => r.kind === kind && (kind === "team" || r.memberId === me));
    return runner?.name ?? null;
  }

  return (
    <form
      className="df"
      aria-label={n.dispatch}
      onSubmit={(event) => {
        event.preventDefault();
        if (agent) dispatch.mutate();
      }}
    >
      <div className="df-field">
        <span className="df-label" id="df-runner">
          {n.runOn}
        </span>
        <div className="df-runners" role="radiogroup" aria-labelledby="df-runner">
          {kinds.map((kind) => {
            const online = options[kind]?.online !== false;
            const host = hostOf(kind);
            return (
              // biome-ignore lint/a11y/useSemanticElements: 卡片式的單選
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={runnerKind === kind}
                className="df-runner"
                onClick={() => changeRunnerKind(kind)}
              >
                <span className="df-runner-label">
                  {kind === "local" ? <Monitor {...ICON} /> : <Server {...ICON} />}
                  {kind === "local" ? n.runnerLocal : n.runnerTeam}
                </span>
                <span className="df-runner-host" data-online={online}>
                  <span className="df-dot" />
                  {online ? (host ?? t.labels.runnerKind[kind]) : n.runnerOffline}
                </span>
              </button>
            );
          })}
        </div>
        {options[runnerKind]?.online === false && (
          <span className="df-muted">{n.offlineQueued}</span>
        )}
      </div>

      <div className="df-field">
        <span className="df-label" id="df-agent">
          {n.agent}
        </span>
        {agents.length === 0 && <span className="df-muted">{n.noAgents}</span>}
        <div className="df-agents" role="radiogroup" aria-labelledby="df-agent">
          {agents.map((option) => {
            const selected = option.id === agentId;
            return (
              // biome-ignore lint/a11y/useSemanticElements: 列表式的單選
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-disabled={!option.available || undefined}
                className="df-agent"
                onClick={() => {
                  if (!option.available) return;
                  setAgentId(option.id);
                  setModel("");
                }}
              >
                <span className="df-mark" aria-hidden="true">
                  {selected ? "●" : "○"}
                </span>
                <span className="df-agent-logo" data-off={!option.available}>
                  <AgentLogo agent={option.id} size={16} />
                </span>
                <span className="df-mono">{option.id}</span>
                {option.version && <span className="df-mono-muted">{option.version}</span>}
                {!option.available && (
                  <span className="df-off">{option.unavailableReason ?? n.unavailable}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="df-row">
        <label className="df-field">
          <span className="df-label">{n.model}</span>
          <select
            className="df-select"
            value={model}
            disabled={!agent || agent.models.length === 0}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">{n.agentDefault}</option>
            {agent?.models.map((name) => (
              <option key={name} value={name}>
                {modelDisplayName(name)}
              </option>
            ))}
          </select>
        </label>
        <div className="df-field">
          <span className="df-label">{n.policy}</span>
          <Segmented<PermissionPolicy>
            label={n.policy}
            value={policy}
            onChange={setPolicy}
            options={policies.map((value) => ({ value, label: t.labels.permissionPolicy[value] }))}
          />
        </div>
      </div>

      <div className="df-notes">
        <span className="df-muted">{t.labels.permissionPolicyDescription[policy]}</span>
        {policies.includes(options.defaultPermissionPolicy) && (
          <span className="df-muted">
            {n.projectDefault(t.labels.permissionPolicy[options.defaultPermissionPolicy])}
          </span>
        )}
        {!policies.includes(options.defaultPermissionPolicy) && (
          <span className="df-muted" role="note">
            {n.defaultPolicyUnavailable(t.labels.permissionPolicy[options.defaultPermissionPolicy])}
          </span>
        )}
        {policy === "yolo" && (
          <span className="df-warn" role="alert">
            {n.yoloWarning}
          </span>
        )}
        {agent && agent.permissionGaps.length > 0 && (
          <div className="df-warn" role="note">
            {n.permissionGaps}
            <ul>
              {agent.permissionGaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <ErrorText error={dispatch.error} />
      <div className="df-actions">
        {onCancel && (
          <button
            type="button"
            className="o-btn"
            data-variant="ghost"
            data-size="lg"
            onClick={onCancel}
          >
            {t.common.cancel}
          </button>
        )}
        <button
          type="submit"
          className="o-btn"
          data-variant="primary"
          data-size="lg"
          disabled={!agent || dispatch.isPending}
        >
          {n.dispatch}
        </button>
      </div>
    </form>
  );
}
