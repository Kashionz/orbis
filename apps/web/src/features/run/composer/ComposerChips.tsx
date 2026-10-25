// 輸入框底部的 chip：模型、推理強度、權限策略、執行電腦。
// 執行中切換設定是後端缺口（TODO(backend, run-settings)）：真實模式停用並顯示「尚未開放」。

import type { PermissionPolicy, Run } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Shield } from "lucide-react";
import { useRef, useState } from "react";
import { queryKeys, runnersQuery } from "../../../api/resources";
import { AgentLogo } from "../../../components/AgentLogo";
import { type MenuGroup, Popover } from "../../../components/Popover";
import { useToast } from "../../../components/Toast";
import { useT } from "../../../i18n";
import { isFeatureEnabled } from "../../../lib/features";
import { permissionPoliciesFor } from "../../../lib/permissions";
import {
  catalogModel,
  EFFORT_LEVELS,
  type EffortLevel,
  modelDisplayName,
  useAgentCatalog,
} from "../../agents/catalog";
import type { RunSettings, UpdateRunSettingsInput } from "../types";
import { updateRunSettings, workspaceKeys } from "../workspace-api";

const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

interface ChipsProps {
  run: Run;
  projectId: string;
  settings: RunSettings | null;
  /** Run 已結束，或沒有控制 Run 的權限。 */
  locked: boolean;
  /** Runner 連線中（執行電腦的圖示顏色）。 */
  connected: boolean;
}

function useSwitch(run: Run) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: UpdateRunSettingsInput) => updateRunSettings(run.id, input),
    onSuccess: (settings) => {
      queryClient.setQueryData(workspaceKeys.runSettings(run.id), settings);
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(run.id) });
    },
    onError: (error) => toast.show(error instanceof Error ? error.message : String(error)),
  });
}

export function ComposerChips({ run, projectId, settings, locked, connected }: ChipsProps) {
  const t = useT();
  const c = t.workspace.composer;
  const available = isFeatureEnabled("runSettings");
  const switchSettings = useSwitch(run);
  const blocked = locked || !available || switchSettings.isPending;
  const reason = !available ? t.common.notAvailableYet : null;

  return (
    <div className="cp-chips">
      <ModelChip
        run={run}
        projectId={projectId}
        disabled={blocked}
        reason={reason}
        onSelect={(agent, model) =>
          switchSettings.mutate(agent === run.agent ? { model } : { agent, model })
        }
      />
      <EffortChip
        run={run}
        settings={settings}
        disabled={blocked}
        reason={reason}
        onSelect={(effort) => switchSettings.mutate({ effort })}
      />
      <PolicyChip
        run={run}
        disabled={blocked}
        reason={reason}
        onSelect={(permissionPolicy) => switchSettings.mutate({ permissionPolicy })}
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
  run,
  projectId,
  disabled,
  reason,
  onSelect,
}: ChipProps & { run: Run; projectId: string; onSelect: (agent: string, model: string) => void }) {
  const t = useT();
  const c = t.workspace.composer;
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { data: catalog } = useAgentCatalog(projectId);
  const current = `${run.agent}|${run.model ?? ""}`;
  const groups: MenuGroup<string>[] = catalog
    .filter((entry) => entry.models.length > 0)
    .map((entry) => ({
      title: entry.tool,
      titleSub: entry.vendor,
      logo: <AgentLogo agent={entry.agentId} size={14} />,
      items: entry.models.map((model) => ({
        value: `${entry.agentId}|${model.id}`,
        label: model.name,
        tag: model.tag ? t.workspace.modelTag[model.tag] : undefined,
        checked: `${entry.agentId}|${model.id}` === current,
      })),
    }));
  const name = run.model ? modelDisplayName(run.model) : c.agentDefaultModel;
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
        <AgentLogo agent={run.agent} size={14} />
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
  run,
  settings,
  disabled,
  reason,
  onSelect,
}: ChipProps & {
  run: Run;
  settings: RunSettings | null;
  onSelect: (effort: EffortLevel) => void;
}) {
  const t = useT();
  const c = t.workspace.composer;
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const mode = run.model ? catalogModel(run.model).effort : "adjustable";
  const unsupported = mode === "none";
  const fixed = mode.startsWith("fixed:") ? (mode.slice("fixed:".length) as EffortLevel) : null;
  const current: EffortLevel = fixed ?? settings?.effort ?? "std";
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
  disabled,
  reason,
  onSelect,
}: ChipProps & { run: Run; onSelect: (policy: PermissionPolicy) => void }) {
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
        aria-label={`${c.policy} ${t.labels.permissionPolicy[run.permissionPolicy]}`}
        aria-disabled={disabled || undefined}
        data-tip={reason ?? c.policy}
        data-open={open}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        <Shield {...ICON} />
        <span className="cp-mono">{t.labels.permissionPolicy[run.permissionPolicy]}</span>
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
              checked: policy === run.permissionPolicy,
              disabled: !allowed.includes(policy),
              disabledReason: c.policyLocalOnly,
            })),
          },
        ]}
        onSelect={(policy) => policy !== run.permissionPolicy && onSelect(policy)}
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
