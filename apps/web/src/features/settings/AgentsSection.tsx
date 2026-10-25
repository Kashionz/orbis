// 設定→代理：每個代理的登入狀態、重新登入、預設模型。

import { useQueryClient } from "@tanstack/react-query";
import { AgentLogo } from "../../components/AgentLogo";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/ErrorText";
import { Popover, useMenu } from "../../components/Popover";
import { StatusDot } from "../../components/StatusDot";
import { useToast } from "../../components/Toast";
import { useT } from "../../i18n";
import { isFeatureEnabled } from "../../lib/features";
import { type AgentCatalogEntry, useAgentCatalog } from "../agents/catalog";
import { useAgentDefaultModels } from "../agents/default-models";
import { useShell } from "../shell/shell-context";
import { useAgentRelogin } from "./api";

export function AgentsSection() {
  const t = useT();
  const { project } = useShell();
  const { data: catalog, error, isLoading } = useAgentCatalog(project?.id);
  return (
    <>
      <ErrorText error={error} />
      {!isLoading && catalog.length === 0 && (
        <p className="settings-empty">{t.settings.noAgents}</p>
      )}
      <div className="settings-list">
        {catalog.map((entry) => (
          <AgentRow key={entry.agentId} entry={entry} />
        ))}
      </div>
    </>
  );
}

function AgentRow({ entry }: { entry: AgentCatalogEntry }) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const menu = useMenu();
  const relogin = useAgentRelogin();
  const defaults = useAgentDefaultModels();
  const reloginEnabled = isFeatureEnabled("agentRelogin");
  const modelId = defaults.defaultModelOf(entry);
  const model = entry.models.find((m) => m.id === modelId);

  return (
    <div className="setting-item" data-agent={entry.agentId}>
      <span className="setting-icon-box">
        <AgentLogo agent={entry.agentId} size={16} />
      </span>
      <span className="setting-item-text">
        <span className="setting-mono setting-item-name">{entry.agentId}</span>
        <span className="setting-status" data-tone={entry.signedIn ? undefined : "warn"}>
          <StatusDot color="currentColor" />
          {entry.signedIn ? t.settings.signedIn : t.settings.needsSignIn}
        </span>
      </span>
      {!entry.signedIn && (
        // TODO(backend, agent-relogin)：Runner 還不能遠端觸發代理的登入流程
        <Button
          disabled={!reloginEnabled || relogin.isPending}
          data-tip={reloginEnabled ? undefined : t.common.notAvailableYet}
          onClick={() =>
            relogin.mutate(entry.agentId, {
              onSuccess: () => {
                toast.show(t.settings.signingIn(entry.tool));
                void queryClient.invalidateQueries({ queryKey: ["agent-catalog"] });
              },
            })
          }
        >
          {t.settings.signIn}
        </Button>
      )}
      <button
        ref={menu.anchorRef}
        type="button"
        className="setting-model"
        aria-label={`${t.settings.defaultModelOf(entry.tool)}：${model?.name ?? t.settings.agentDefault}`}
        disabled={entry.models.length === 0}
        {...menu.triggerProps}
      >
        <span className="setting-model-name">{model?.name ?? t.settings.agentDefault}</span>
      </button>
      <Popover
        {...menu.popoverProps}
        label={t.settings.defaultModelOf(entry.tool)}
        minWidth={180}
        prefer="down"
        align="end"
        onSelect={(id: string) => defaults.setDefaultModel(entry.agentId, id)}
        groups={[
          {
            items: entry.models.map((m) => ({
              value: m.id,
              label: m.name,
              mono: true,
              tag: m.tag ? t.labels.modelTag[m.tag] : undefined,
              checked: m.id === modelId,
            })),
          },
        ]}
      />
      <ErrorText error={relogin.error} />
    </div>
  );
}
