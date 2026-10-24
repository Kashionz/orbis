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
      <h2 id="admin-runners">Runner</h2>
      <div className="notice-inline terms-warning" role="note" aria-label="共用訂閱的條款風險">
        <strong>條款風險：Team Runner 共用一個 Claude 訂閱。</strong>
        根據第三方整理（非官方條文），Consumer Terms 禁止共用帳號登入或憑證，訂閱的 OAuth token
        限定用在 Claude Code 與 claude.ai，訂閱額度以一般個人使用為前提。最壞情況是帳號被停權，
        整個團隊的 Agent 會同時停擺。建議向 Anthropic 確認條款，必要時改用 API key 或團隊方案。
        Local Runner 不受影響，每個人仍使用自己的登入。
      </div>
      <ErrorText error={error} />
      {runners.length === 0 ? (
        <p className="empty">還沒有任何 Runner 完成 Pairing。</p>
      ) : (
        <table className="run-table runner-table">
          <thead>
            <tr>
              <th scope="col">Runner</th>
              <th scope="col">種類</th>
              <th scope="col">狀態</th>
              <th scope="col">Agent</th>
              <th scope="col">最後心跳</th>
            </tr>
          </thead>
          <tbody>
            {runners.map((runner) => (
              <tr key={runner.id} data-runner={runner.name}>
                <td>
                  {runner.name}
                  <span className="hint">
                    {" "}
                    {runner.os}/{runner.arch} v{runner.runnerVersion}
                  </span>
                </td>
                <td>{t.labels.runnerKind[runner.kind]}</td>
                <td>
                  {runner.online
                    ? runner.acceptingDispatches
                      ? "在線"
                      : "在線（暫停領取）"
                    : "離線"}
                </td>
                <td>
                  {runner.agents
                    .map((a) => `${a.agent}${a.available ? "" : "（無法使用）"}`)
                    .join("、")}
                </td>
                <td>{runner.lastHeartbeatAt ? formatTime(runner.lastHeartbeatAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>新增 Team Runner</h3>
      <p className="hint">
        產生一次性的 Pairing token（24 小時內有效），在 Team Runner 的容器中設定後啟動。
      </p>
      <button type="button" disabled={create.isPending} onClick={() => create.mutate()}>
        產生 Team Runner 的 Pairing token
      </button>
      <ErrorText error={create.error} />
      {token && (
        <div className="pairing-token" role="status">
          <p>Pairing token（只會顯示這一次，{formatTime(token.expiresAt)} 前有效）：</p>
          <code data-testid="pairing-token">{token.token}</code>
          <p className="hint">
            在容器的環境變數設定 <code>{NAMES.runnerEnv.pairingToken}</code>（這個 token）與{" "}
            <code>{NAMES.runnerEnv.serverUrl}</code>（{window.location.origin}）後啟動 Runner。
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
  const { data: needsYou = [] } = useQuery(needsYouQuery);
  const trust = needsYou.filter(
    (item): item is NeedsYouItem & { kind: "permission_request" } =>
      item.kind === "permission_request" && item.purpose === "config_trust",
  );
  return (
    <section className="section" aria-labelledby="admin-policy">
      <h2 id="admin-policy">Permission Policy 與設定的信任核准</h2>
      <table className="run-table policy-table">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">預設 Permission Policy</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <ProjectPolicyRow key={`${project.id}-${project.updatedAt}`} project={project} />
          ))}
        </tbody>
      </table>
      <h3>
        等待核准的 <code>{`${NAMES.configDir}/${NAMES.configFile}`}</code> 信任請求
      </h3>
      {trust.length === 0 ? (
        <p className="empty">沒有等待核准的請求。</p>
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
          aria-label={`${project.name} 的預設 Permission Policy`}
          value={value}
          onChange={(event) => setValue(event.target.value as PermissionPolicy)}
        >
          {PERMISSION_POLICIES.map((p) => (
            <option key={p} value={p}>
              {t.labels.permissionPolicy[p]}
            </option>
          ))}
        </select>{" "}
        <button
          type="button"
          disabled={value === project.policy.defaultPermissionPolicy || save.isPending}
          onClick={() => save.mutate()}
        >
          儲存
        </button>
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
          <button
            key={option.optionId}
            type="button"
            className={option.kind.startsWith("allow") ? "primary" : "danger"}
            disabled={respond.isPending}
            onClick={() => respond.mutate(option.optionId)}
          >
            {option.name}
          </button>
        ))}
      </span>
      <ErrorText error={respond.error} />
    </li>
  );
}
