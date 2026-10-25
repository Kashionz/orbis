import {
  NAMES,
  type NeedsYouItem,
  type PairingTokenCreated,
  PERMISSION_POLICIES,
  type PermissionPolicy,
  type Project,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  createPairingToken,
  needsYouQuery,
  queryKeys,
  respondToPermission,
  runnersQuery,
  updateProject,
} from "../../api/resources";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/ErrorText";
import { useT } from "../../i18n";
import { formatTime } from "../../lib/format";

/**
 * Team Runner 與 Pairing token（ARCHITECTURE §6.1、§7，Admin 以上）。Team Runner 共用一個 Claude 訂閱，
 * 依 ADR-0005 在這裡清楚顯示條款風險。
 */
export function RunnersSection() {
  const t = useT();
  const { data: runners = [], error } = useQuery(runnersQuery);
  const [token, setToken] = useState<PairingTokenCreated | null>(null);
  const create = useMutation({ mutationFn: () => createPairingToken("team"), onSuccess: setToken });

  return (
    <section className="section" aria-labelledby="admin-runners">
      <h2 id="admin-runners">{t.admin.runners}</h2>
      <div className="notice-inline terms-warning" role="note" aria-label={t.admin.termsRiskLabel}>
        <strong>{t.admin.termsRiskTitle}</strong> {t.admin.termsRiskBody}
      </div>
      <ErrorText error={error} />
      {runners.length === 0 ? (
        <p className="empty">{t.admin.noRunners}</p>
      ) : (
        <table className="run-table runner-table">
          <thead>
            <tr>
              <th scope="col">{t.admin.runnerColumns.runner}</th>
              <th scope="col">{t.admin.runnerColumns.kind}</th>
              <th scope="col">{t.admin.runnerColumns.status}</th>
              <th scope="col">{t.admin.runnerColumns.agents}</th>
              <th scope="col">{t.admin.runnerColumns.lastHeartbeat}</th>
            </tr>
          </thead>
          <tbody>
            {runners.map((runner) => (
              <tr key={runner.id} data-runner={runner.name}>
                <td>
                  {runner.name}
                  <span className="hint">
                    {" "}
                    {t.admin.runnerMeta(runner.os, runner.arch, runner.runnerVersion)}
                  </span>
                </td>
                <td>{t.labels.runnerKind[runner.kind]}</td>
                <td>
                  {runner.online
                    ? runner.acceptingDispatches
                      ? t.admin.runnerOnline
                      : t.admin.runnerOnlinePaused
                    : t.admin.runnerOffline}
                </td>
                <td>
                  {runner.agents
                    .map((a) => (a.available ? a.agent : t.admin.agentUnavailable(a.agent)))
                    .join(t.common.listSeparator)}
                </td>
                <td>{runner.lastHeartbeatAt ? formatTime(runner.lastHeartbeatAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>{t.admin.addTeamRunner}</h3>
      <p className="hint">{t.admin.addTeamRunnerHint}</p>
      <Button disabled={create.isPending} onClick={() => create.mutate()}>
        {t.admin.createTeamToken}
      </Button>
      <ErrorText error={create.error} />
      {token && (
        <div className="pairing-token" role="status">
          <p>{t.admin.tokenOnce(formatTime(token.expiresAt))}</p>
          <code data-testid="pairing-token">{token.token}</code>
          <p className="hint">
            {t.admin.tokenEnvBefore} <code>{NAMES.runnerEnv.pairingToken}</code>
            {t.admin.tokenEnvToken} <code>{NAMES.runnerEnv.serverUrl}</code>
            {t.admin.tokenEnvAfter(window.location.origin)}
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * Permission Policy 與設定的信任核准（ARCHITECTURE §6.2、§8，Admin 以上）：各 Project 的預設
 * Permission Policy，以及等待核准的 Repo 設定檔信任請求。
 */
export function PolicySection({ projects }: { projects: readonly Project[] }) {
  const t = useT();
  const { data: needsYou = [] } = useQuery(needsYouQuery);
  const trust = needsYou.filter(
    (item): item is NeedsYouItem & { kind: "permission_request" } =>
      item.kind === "permission_request" && item.purpose === "config_trust",
  );
  return (
    <section className="section" aria-labelledby="admin-policy">
      <h2 id="admin-policy">{t.admin.policy}</h2>
      <table className="run-table policy-table">
        <thead>
          <tr>
            <th scope="col">{t.admin.policyColumns.project}</th>
            <th scope="col">{t.admin.policyColumns.defaultPolicy}</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <ProjectPolicyRow key={`${project.id}-${project.updatedAt}`} project={project} />
          ))}
        </tbody>
      </table>
      <h3>{t.admin.trustRequests(`${NAMES.configDir}/${NAMES.configFile}`)}</h3>
      {trust.length === 0 ? (
        <p className="empty">{t.admin.noTrustRequests}</p>
      ) : (
        <ul className="trust-requests">
          {trust.map((item) => (
            <TrustRequest key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ProjectPolicyRow({ project }: { project: Project }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [value, setValue] = useState<PermissionPolicy>(project.policy.defaultPermissionPolicy);
  const save = useMutation({
    mutationFn: () => updateProject(project.id, { policy: { defaultPermissionPolicy: value } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
  });
  return (
    <tr data-project={project.keyPrefix}>
      <td>{project.name}</td>
      <td>
        <select
          aria-label={t.admin.defaultPolicyOf(project.name)}
          value={value}
          onChange={(event) => setValue(event.target.value as PermissionPolicy)}
        >
          {PERMISSION_POLICIES.map((p) => (
            <option key={p} value={p}>
              {t.labels.permissionPolicy[p]}
            </option>
          ))}
        </select>{" "}
        <Button
          disabled={value === project.policy.defaultPermissionPolicy || save.isPending}
          onClick={() => save.mutate()}
        >
          {t.common.save}
        </Button>
        <ErrorText error={save.error} />
      </td>
    </tr>
  );
}

function TrustRequest({ item }: { item: NeedsYouItem & { kind: "permission_request" } }) {
  const queryClient = useQueryClient();
  const respond = useMutation({
    mutationFn: (optionId: string) =>
      respondToPermission(item.runId, item.permissionRequestId, { optionId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.needsYou }),
  });
  return (
    <li className="trust-request">
      <Link to="/tasks/$taskKey" params={{ taskKey: item.taskKey }}>
        {item.taskKey}
      </Link>{" "}
      {item.title}
      <span className="form-actions">
        {item.options.map((option) => (
          <Button
            key={option.optionId}
            variant={option.kind.startsWith("allow") ? "primary" : "danger-ghost"}
            disabled={respond.isPending}
            onClick={() => respond.mutate(option.optionId)}
          >
            {option.name}
          </Button>
        ))}
      </span>
      <ErrorText error={respond.error} />
    </li>
  );
}
