// 設定→執行器：Runner 清單（在線狀態、版本）、預設終端、Windows 長路徑、配對新的執行器。

import { NAMES, type PairingTokenCreated, type Runner, type RunnerKind } from "@orbis/api-contract";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Check, Copy, Monitor, Plus, Server } from "lucide-react";
import { useState } from "react";
import { createPairingToken, runnersQuery } from "../../api/resources";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/ErrorText";
import { Popover, useMenu } from "../../components/Popover";
import { Segmented } from "../../components/Segmented";
import { StatusDot } from "../../components/StatusDot";
import { Switch } from "../../components/Switch";
import { useT } from "../../i18n";
import { formatTime } from "../../lib/format";
import { TERMINAL_SHELLS, type TerminalShell, usePreferences } from "../../lib/preferences";
import { meQueryOptions } from "../auth/api";
import { usePermissions } from "../auth/use-permissions";
import { localRunnerOf } from "../shell/ProfileMenu";
import { SettingRow } from "./SettingsDialog";

/** 終端機的名稱（專有名詞，不翻譯）。 */
export const TERMINAL_SHELL_NAMES: Record<TerminalShell, string> = {
  powershell: "PowerShell",
  cmd: "cmd",
  "git-bash": "Git Bash",
};

export function RunnersSettingsSection() {
  const t = useT();
  const preferences = usePreferences();
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const { data: runners = [], error } = useQuery(runnersQuery);
  const local = localRunnerOf(runners, me.member?.id);

  return (
    <>
      <ErrorText error={error} />
      {runners.length === 0 && <p className="settings-empty">{t.settings.noRunners}</p>}
      <div className="settings-items">
        {runners.map((runner) => (
          <RunnerRow key={runner.id} runner={runner} />
        ))}
      </div>
      <SettingRow label={t.settings.defaultShell}>
        <Segmented
          label={t.settings.defaultShell}
          value={preferences.terminalShell}
          onChange={preferences.setTerminalShell}
          options={TERMINAL_SHELLS.map((value) => ({
            value,
            label: TERMINAL_SHELL_NAMES[value],
          }))}
        />
      </SettingRow>
      <LongPathsRow />
      <PairRunner />
    </>
  );
}

function RunnerRow({ runner }: { runner: Runner }) {
  const t = useT();
  const status = runner.online
    ? runner.acceptingDispatches
      ? { label: t.settings.runnerOnline, color: "var(--o4fb86a)" }
      : { label: t.settings.runnerPaused, color: "var(--od9a845)" }
    : { label: t.settings.runnerOffline, color: "var(--o8b9098)" };
  return (
    <div className="setting-item" data-runner={runner.name}>
      <span className="setting-icon-box">
        {runner.kind === "local" ? <Monitor size={16} /> : <Server size={16} />}
      </span>
      <span className="setting-item-text">
        <span className="setting-mono setting-item-name">{runner.name}</span>
        <span className="setting-sub setting-item-meta">
          <span>{runner.os}</span>
          <span>{t.labels.runnerKind[runner.kind]}</span>
        </span>
      </span>
      <span className="setting-status">
        <StatusDot color={status.color} />
        {status.label}
      </span>
      <span className="setting-mono setting-version">v{runner.runnerVersion}</span>
    </div>
  );
}

/** Windows 長路徑：Runner 在 Windows 上一律開啟 `core.longpaths`（#84），只顯示狀態。 */
function LongPathsRow() {
  const t = useT();
  return (
    <SettingRow label={t.settings.windowsLongPaths}>
      <span className="setting-status" data-tip={t.settings.windowsLongPathsAlwaysOn}>
        <StatusDot color="currentColor" />
        {t.settings.alwaysOn}
      </span>
    </SettingRow>
  );
}

function PairRunner() {
  const t = useT();
  const permissions = usePermissions();
  const menu = useMenu();
  const [token, setToken] = useState<PairingTokenCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: (kind: RunnerKind) => createPairingToken(kind),
    onSuccess: (created) => {
      setCopied(false);
      setToken(created);
    },
  });
  const canTeam = permissions.can("team.manage");

  return (
    <div className="settings-pair">
      <Button
        ref={menu.anchorRef}
        icon={<Plus size={14} />}
        disabled={create.isPending}
        {...menu.triggerProps}
      >
        {t.settings.pairRunner}
      </Button>
      <Popover
        {...menu.popoverProps}
        label={t.settings.pairRunner}
        minWidth={240}
        selectable={false}
        onSelect={(kind: RunnerKind) => create.mutate(kind)}
        groups={[
          {
            items: [
              {
                value: "local" as RunnerKind,
                label: t.settings.pairLocal,
                sub: t.settings.pairLocalSub,
                icon: <Monitor size={14} />,
              },
              ...(canTeam
                ? [
                    {
                      value: "team" as RunnerKind,
                      label: t.settings.pairTeam,
                      sub: t.settings.pairTeamSub,
                      icon: <Server size={14} />,
                    },
                  ]
                : []),
            ],
          },
        ]}
      />
      <ErrorText error={create.error} />
      {token && (
        <div className="settings-token" role="status">
          <span className="setting-sub">
            {t.settings.pairingToken}
            {"："}
            {t.labels.runnerKind[token.kind]}
          </span>
          <div className="settings-token-row">
            <code data-testid="pairing-token">{token.token}</code>
            <Button
              variant="ghost"
              size="sm"
              icon={copied ? <Check size={14} /> : <Copy size={14} />}
              onClick={() => {
                void navigator.clipboard?.writeText(token.token).catch(() => {});
                setCopied(true);
              }}
            >
              {copied ? t.common.copied : t.common.copy}
            </Button>
          </div>
          <span className="setting-sub">
            {t.settings.pairingTokenExpires(formatTime(token.expiresAt))}
          </span>
          <span className="setting-sub">
            {t.settings.pairingTokenEnv(NAMES.runnerEnv.pairingToken, NAMES.runnerEnv.serverUrl)}
          </span>
        </div>
      )}
    </div>
  );
}
