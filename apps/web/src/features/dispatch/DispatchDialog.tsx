import {
  type PermissionPolicy,
  type Project,
  RUNNER_KINDS,
  type Run,
  type RunnerKind,
  type Task,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { dispatchOptionsQuery, dispatchRun, queryKeys } from "../../api/resources";
import type { AgentOption, DispatchOptions } from "../../api/schemas";
import { Dialog } from "../../components/Dialog";
import { ErrorText } from "../../components/ErrorText";
import { PERMISSION_POLICY_LABELS, RUNNER_KIND_LABELS } from "../../lib/labels";
import {
  canDispatchTo,
  defaultPermissionPolicy,
  permissionPoliciesFor,
} from "../../lib/permissions";
import { usePermissions } from "../auth/use-permissions";

interface DispatchDialogProps {
  task: Task;
  project: Project;
  open: boolean;
  onClose: () => void;
  onDispatched: (run: Run) => void;
}

/** 派工對話框：選 Agent、在哪裡跑、Permission Policy（交付 3）。 */
export function DispatchDialog({
  task,
  project,
  open,
  onClose,
  onDispatched,
}: DispatchDialogProps) {
  return (
    <Dialog title={`派工 ${task.key}`} open={open} onClose={onClose}>
      {open && (
        <DispatchForm task={task} project={project} onClose={onClose} onDispatched={onDispatched} />
      )}
    </Dialog>
  );
}

function firstAvailable(agents: readonly AgentOption[]): string {
  return agents.find((agent) => agent.available)?.id ?? "";
}

function DispatchForm({ task, project, onClose, onDispatched }: Omit<DispatchDialogProps, "open">) {
  const { data: options, error: loadError, isPending } = useQuery(dispatchOptionsQuery);
  const { ctx } = usePermissions(project, task);

  if (isPending) return <p>正在讀取可用的 Agent…</p>;
  if (loadError || !options) return <ErrorText error={loadError} />;

  const kinds = RUNNER_KINDS.filter((kind) => canDispatchTo(kind, ctx) && options[kind] !== null);
  if (kinds.length === 0) {
    return (
      <>
        <p className="empty">
          目前沒有可以派工的 Runner。請先在桌面版完成 Local Runner 的 Pairing，或請 Admin 設定 Team
          Runner。
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            關閉
          </button>
        </div>
      </>
    );
  }
  return (
    <DispatchFields
      task={task}
      project={project}
      options={options}
      kinds={kinds}
      onClose={onClose}
      onDispatched={onDispatched}
    />
  );
}

interface DispatchFieldsProps {
  task: Task;
  project: Project;
  options: DispatchOptions;
  kinds: RunnerKind[];
  onClose: () => void;
  onDispatched: (run: Run) => void;
}

function DispatchFields({
  task,
  project,
  options,
  kinds,
  onClose,
  onDispatched,
}: DispatchFieldsProps) {
  const queryClient = useQueryClient();
  const initialKind = kinds[0] ?? "local";
  const [runnerKind, setRunnerKind] = useState<RunnerKind>(initialKind);
  const target = options[runnerKind];
  const agents = target?.agents ?? [];
  const [agentId, setAgentId] = useState(() => firstAvailable(options[initialKind]?.agents ?? []));
  const [model, setModel] = useState("");
  const [policy, setPolicy] = useState<PermissionPolicy>(() =>
    defaultPermissionPolicy(project, initialKind),
  );
  const agent = agents.find((a) => a.id === agentId && a.available);

  const mutation = useMutation({
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
      setPolicy(defaultPermissionPolicy(project, kind));
    }
  }

  return (
    <form
      className="dispatch-form"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <fieldset>
        <legend>在哪裡跑</legend>
        {kinds.map((kind) => (
          <label key={kind} className="choice">
            <input
              type="radio"
              name="runner-kind"
              value={kind}
              checked={runnerKind === kind}
              onChange={() => changeRunnerKind(kind)}
            />
            {RUNNER_KIND_LABELS[kind]}
            {options[kind]?.online === false && (
              <span className="hint">（目前離線，Run 會排隊）</span>
            )}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Agent</legend>
        {agents.length === 0 && <p className="empty">這種 Runner 上沒有可用的 Agent。</p>}
        {agents.map((option) => (
          <label key={option.id} className="choice">
            <input
              type="radio"
              name="agent"
              value={option.id}
              checked={agentId === option.id}
              disabled={!option.available}
              onChange={() => {
                setAgentId(option.id);
                setModel("");
              }}
            />
            {option.id}
            {option.version && <span className="hint"> {option.version}</span>}
            {!option.available && (
              <span className="hint">（無法使用：{option.unavailableReason ?? "原因不明"}）</span>
            )}
          </label>
        ))}
      </fieldset>

      {agent && agent.models.length > 0 && (
        <label className="field">
          Model
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="">Agent 預設</option>
            {agent.models.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}

      {agent && agent.permissionGaps.length > 0 && (
        <div className="warning" role="note">
          <strong>{agent.id} 有 Permission Policy 無法攔截的操作：</strong>
          <ul>
            {agent.permissionGaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </div>
      )}

      <fieldset>
        <legend>Permission Policy</legend>
        {permissionPoliciesFor(runnerKind).map((value) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="permission-policy"
              value={value}
              checked={policy === value}
              onChange={() => setPolicy(value)}
            />
            {PERMISSION_POLICY_LABELS[value]}
          </label>
        ))}
      </fieldset>
      {policy === "yolo" && (
        <div className="warning" role="alert">
          yolo 會自動允許 Agent
          的所有操作（寫入主分支除外），而且是在你自己的電腦上執行。請確認你信任這個 Task 與 Agent。
        </div>
      )}

      <ErrorText error={mutation.error} />
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="primary" disabled={!agent || mutation.isPending}>
          {mutation.isPending ? "派工中…" : "派工"}
        </button>
      </div>
    </form>
  );
}
