// 輸入框底部的 chip：模型、推理強度、權限策略、執行電腦。
// 切換以 RunControl 送給 Runner（回 202），生效時 Runner 送 Event，之後重新取得 Run 的設定。
// 選了其他 Agent 的模型是換 Agent（同一個 Run 與 Worktree，回合中選擇時等回合結束）。

import type {
  PermissionPolicy,
  Run,
  RunSettings,
  UpdateRunSettingsInput,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Shield } from "lucide-react";
import { useRef, useState } from "react";
import { errorMessage } from "../../../api/client";
import { queryKeys, runnersQuery } from "../../../api/resources";
import { AgentLogo } from "../../../components/AgentLogo";
import { type MenuGroup, Popover } from "../../../components/Popover";
import { useToast } from "../../../components/Toast";
import { useT } from "../../../i18n";
import { permissionPoliciesFor } from "../../../lib/permissions";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  findModel,
  modelDisplayName,
  useAgentCatalog,
} from "../../agents/catalog";
import { switchRunAgent, updateRunSettings, workspaceKeys } from "../workspace-api";

const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

interface ChipsProps {
  run: Run;
  settings: RunSettings | null;
  /** Run 已結束，或沒有控制 Run 的權限。 */
  locked: boolean;
  /** Runner 連線中（執行電腦的圖示顏色）。 */
  connected: boolean;
  /** 能換 Permission Policy 與換 Agent：Local Runner 上只限那台 Runner 的擁有者。 */
  runnerOwner: boolean;
}

type SwitchRequest =
  | { kind: "settings"; input: UpdateRunSettingsInput }
  | { kind: "agent"; agent: string; model: string };

function useSwitch(run: Run) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const t = useT();
  return useMutation({
    mutationFn: async (request: SwitchRequest) => {
      if (request.kind === "agent") {
        await switchRunAgent(run.id, { agent: request.agent, model: request.model });
      } else {
        await updateRunSettings(run.id, request.input);
      }
    },
    onSuccess: () => {
      toast.show(t.workspace.composer.switchRequested);
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.runSettings(run.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(run.id) });
    },
    onError: (error) => toast.show(errorMessage(error)),
  });
}

export function ComposerChips({ run, settings, locked, connected, runnerOwner }: ChipsProps) {
  const t = useT();
  const c = t.workspace.composer;
  const switchSettings = useSwitch(run);
  const blocked = locked || switchSettings.isPending;
  // 目前已生效的設定（派工時的值，加上之後生效的切換）
  const current = settings?.current ?? {
    agent: run.agent,
    model: run.model,
    effort: run.effort,
    permissionPolicy: run.permissionPolicy,
  };

  return (
    <div className="cp-chips">
      <ModelChip
        agent={current.agent}
        model={current.model}
        disabled={blocked}
        reason={null}
        otherAgents={runnerOwner}
        onSelect={(agent, model) =>
          switchSettings.mutate(
            agent === current.agent
              ? { kind: "settings", input: { model } }
              : { kind: "agent", agent, model },
          )
        }
      />
      <EffortChip
        agent={current.agent}
        model={current.model}
        effort={current.effort}
        disabled={blocked}
        reason={null}
        onSelect={(effort) => switchSettings.mutate({ kind: "settings", input: { effort } })}
      />
      <PolicyChip
        run={run}
        policy={current.permissionPolicy}
        disabled={blocked || !runnerOwner}
        reason={!locked && !runnerOwner ? c.runnerOwnerOnly : null}
        onSelect={(permissionPolicy) =>
          switchSettings.mutate({ kind: "settings", input: { permissionPolicy } })
        }
      />
      <RunnerChip run={run} connected={connected} label={c.runner} />
    </div>
  );
}

interface ChipProps {
  disabled: boolean;
  /** 停用的原因（Tooltip）；只是 Run 結束時為 null。 */
  reason: string | null;
}

function ModelChip({
  agent,
  model,
  disabled,
  reason,
  otherAgents,
  onSelect,
}: ChipProps & {
  agent: string;
  model: string | null;
  /** 能不能換成其他 Agent；不能時只列出目前 Agent 的模型。 */
  otherAgents: boolean;
  onSelect: (agent: string, model: string) => void;
}) {
  const t = useT();
  const c = t.workspace.composer;
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { data: catalog } = useAgentCatalog();
  const current = `${agent}|${model ?? ""}`;
  const groups: MenuGroup<string>[] = catalog
    .filter((entry) => entry.models.length > 0 && (otherAgents || entry.agentId === agent))
    .map((entry) => ({
      title: entry.tool,
      titleSub: entry.vendor ?? undefined,
      logo: <AgentLogo agent={entry.agentId} size={14} />,
      items: entry.models.map((model) => ({
        value: `${entry.agentId}|${model.id}`,
        label: model.name,
        tag: model.tag ? t.workspace.modelTag[model.tag] : undefined,
        checked: `${entry.agentId}|${model.id}` === current,
      })),
    }));
  const name = model ? modelDisplayName(model, catalog) : c.agentDefaultModel;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="cp-chip cp-chip-model"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${c.switchModel} ${name}`}
        aria-disabled={disabled || undefined}
        data-tip={reason ?? c.switchModel}
        data-open={open}
        onClick={() => !disabled && groups.length > 0 && setOpen((v) => !v)}
      >
        <AgentLogo agent={agent} size={14} />
        <span className="cp-chip-model-name">{name}</span>
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        groups={groups}
        onSelect={(value) => {
          const [agent = "", model = ""] = value.split("|");
          if (value !== current) onSelect(agent, model);
        }}
        label={c.switchModel}
        prefer="up"
        minWidth={280}
        extraWidth={20}
      />
    </>
  );
}

function EffortChip({
  agent,
  model,
  effort,
  disabled,
  reason,
  onSelect,
}: ChipProps & {
  agent: string;
  model: string | null;
  effort: EffortLevel | null;
  onSelect: (effort: EffortLevel) => void;
}) {
  const t = useT();
  const c = t.workspace.composer;
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { data: catalog } = useAgentCatalog();
  // 模型目錄沒有列出時視為可以調整（Runner 不支援時以「沒有套用」回報）
  const support = (model ? findModel(catalog, agent, model)?.effort : null) ?? {
    kind: "adjustable" as const,
  };
  const unsupported = support.kind === "unsupported";
  const fixed = support.kind === "fixed" ? support.level : null;
  const current: EffortLevel = fixed ?? effort ?? "std";
  const inactive = disabled || unsupported || fixed !== null;
  const tip = unsupported ? c.effortUnsupported : fixed ? c.effort : (reason ?? c.effort);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="cp-chip"
        aria-haspopup={unsupported || fixed ? undefined : "menu"}
        aria-expanded={unsupported || fixed ? undefined : open}
        aria-label={c.effort}
        aria-disabled={inactive || undefined}
        data-unsupported={unsupported}
        data-fixed={fixed !== null}
        data-tip={tip}
        data-open={open}
        onClick={() => !inactive && setOpen((v) => !v)}
      >
        <span className="cp-chip-strong">
          {unsupported ? c.effort : t.workspace.effort[current]}
        </span>
        {fixed && <span className="cp-fixed">{c.fixed}</span>}
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        groups={[
          {
            title: c.effort,
            items: EFFORT_LEVELS.map((level) => ({
              value: level,
              label: t.workspace.effort[level],
              sub: t.workspace.effort.description[level],
              checked: level === current,
            })),
          },
        ]}
        onSelect={(level) => level !== current && onSelect(level)}
        label={c.effort}
        prefer="up"
        minWidth={300}
      />
    </>
  );
}

function PolicyChip({
  run,
  policy: currentPolicy,
  disabled,
  reason,
  onSelect,
}: ChipProps & {
  run: Run;
  policy: PermissionPolicy;
  onSelect: (policy: PermissionPolicy) => void;
}) {
  const t = useT();
  const c = t.workspace.composer;
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const allowed = permissionPoliciesFor(run.runnerKind);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="cp-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${c.policy} ${t.labels.permissionPolicy[currentPolicy]}`}
        aria-disabled={disabled || undefined}
        data-tip={reason ?? c.policy}
        data-open={open}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        <Shield {...ICON} />
        <span className="cp-mono">{t.labels.permissionPolicy[currentPolicy]}</span>
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        groups={[
          {
            items: (["manual", "auto", "yolo"] as const).map((policy) => ({
              value: policy,
              label: t.labels.permissionPolicy[policy],
              sub: t.labels.permissionPolicyDescription[policy],
              mono: true,
              checked: policy === currentPolicy,
              disabled: !allowed.includes(policy),
              disabledReason: c.policyLocalOnly,
            })),
          },
        ]}
        onSelect={(policy) => policy !== currentPolicy && onSelect(policy)}
        label={c.policy}
        prefer="up"
        minWidth={260}
      />
    </>
  );
}

function RunnerChip({ run, connected, label }: { run: Run; connected: boolean; label: string }) {
  const t = useT();
  const { data: runners = [] } = useQuery({ ...runnersQuery, refetchInterval: false });
  const runner = runners.find((r) => r.id === run.runnerId);
  const host = runner?.name ?? t.labels.runnerKind[run.runnerKind];
  return (
    <span className="cp-chip cp-chip-runner" data-tip={label}>
      <span className="cp-runner-icon" data-connected={connected && runner?.online !== false}>
        <Monitor {...ICON} />
      </span>
      <span className="cp-mono cp-ellipsis">{host}</span>
    </span>
  );
}
