import type { CredentialStatus } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  credentialsQuery,
  queryKeys,
  teamRunnerQueueQuery,
  updateRunnerCredential,
} from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { useT } from "../../i18n";
import { formatTime } from "../../lib/format";

const numberFormat = new Intl.NumberFormat("en-US");
const tokens = (value: number | null) => (value === null ? "—" : numberFormat.format(value));

/**
 * Credential 的並行數、用量、rate limit 與排隊數（ARCHITECTURE §7「並行與額度」）。
 * Member 以上都看得到（Server 依 Runner 的可見規則過濾）；只有 Admin 以上能覆寫並行上限。
 */
export function CredentialsSection({ canOverride }: { canOverride: boolean }) {
  const { data: credentials = [], error, isSuccess } = useQuery(credentialsQuery);
  return (
    <section className="section" aria-labelledby="admin-credentials">
      <h2 id="admin-credentials">Credential</h2>
      <ErrorText error={error} />
      {isSuccess && credentials.length === 0 && (
        <p className="empty">還沒有 Runner 回報任何 Credential。</p>
      )}
      {credentials.length > 0 && (
        <table className="run-table credential-table">
          <thead>
            <tr>
              <th scope="col">Credential</th>
              <th scope="col">Runner</th>
              <th scope="col">Agent</th>
              <th scope="col">並行</th>
              <th scope="col">排隊</th>
              <th scope="col">Rate limit</th>
              <th scope="col">最近 24 小時</th>
            </tr>
          </thead>
          <tbody>
            {credentials.map((c) => (
              <CredentialRow
                key={`${c.runnerId}/${c.credential}`}
                credential={c}
                canOverride={canOverride}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CredentialRow({
  credential: c,
  canOverride,
}: {
  credential: CredentialStatus;
  canOverride: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (value: number | null) =>
      updateRunnerCredential(c.runnerId, c.credential, { maxConcurrentRuns: value }),
    onSuccess: async () => {
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.credentials });
    },
  });
  const parsed = Number(editing);
  const valid = editing !== null && Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000;

  return (
    <tr data-credential={c.credential} data-runner={c.runnerName}>
      <td>
        <code>{c.credential}</code>
      </td>
      <td>
        {c.runnerName}
        <span className="hint">
          {" "}
          {t.labels.runnerKind[c.runnerKind]}
          {c.online ? "" : "（離線）"}
        </span>
      </td>
      <td>{c.agents.join("、")}</td>
      <td data-testid="concurrency">
        {c.activeRuns} / {c.maxConcurrentRuns}
        {c.maxConcurrentRunsOverride !== null && (
          <span className="hint">（覆寫；Runner 回報 {c.reportedMaxConcurrentRuns}）</span>
        )}
        {canOverride && editing === null && (
          <button
            type="button"
            className="link-button"
            onClick={() => setEditing(String(c.maxConcurrentRuns))}
          >
            覆寫上限
          </button>
        )}
        {canOverride && editing !== null && (
          <form
            className="inline-form"
            aria-label={`覆寫 ${c.credential} 的並行上限`}
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) save.mutate(parsed);
            }}
          >
            <input
              type="number"
              min={1}
              max={1000}
              aria-label="並行上限"
              value={editing}
              onChange={(event) => setEditing(event.target.value)}
            />
            <button type="submit" className="primary" disabled={!valid || save.isPending}>
              儲存
            </button>
            {c.maxConcurrentRunsOverride !== null && (
              <button type="button" disabled={save.isPending} onClick={() => save.mutate(null)}>
                取消覆寫
              </button>
            )}
            <button type="button" onClick={() => setEditing(null)}>
              取消
            </button>
          </form>
        )}
        <ErrorText error={save.error} />
      </td>
      <td>{c.queuedRuns}</td>
      <td>
        {c.rateLimitedUntil ? (
          <span className="tag rate-limited">至 {formatTime(c.rateLimitedUntil)}</span>
        ) : (
          "正常"
        )}
      </td>
      <td>
        {c.usage24h.runs} 個 Run · 輸入 {tokens(c.usage24h.inputTokens)} · 輸出{" "}
        {tokens(c.usage24h.outputTokens)}
        {c.usage24h.cost && ` · ${c.usage24h.cost.currency} ${c.usage24h.cost.amount.toFixed(2)}`}
      </td>
    </tr>
  );
}

/** Team Runner 的佇列（依順位）。 */
export function TeamRunnerQueueSection() {
  const t = useT();
  const { data: queue = [], error, isSuccess } = useQuery(teamRunnerQueueQuery);
  return (
    <section className="section" aria-labelledby="admin-queue">
      <h2 id="admin-queue">Team Runner 佇列</h2>
      <ErrorText error={error} />
      {isSuccess && queue.length === 0 && <p className="empty">佇列是空的。</p>}
      {queue.length > 0 && (
        <table className="run-table queue-table">
          <thead>
            <tr>
              <th scope="col">順位</th>
              <th scope="col">Task</th>
              <th scope="col">Agent</th>
              <th scope="col">Credential</th>
              <th scope="col">等待原因</th>
              <th scope="col">排入時間</th>
            </tr>
          </thead>
          <tbody>
            {queue.map((item) => (
              <tr key={item.runId}>
                <td>{item.position}</td>
                <td>
                  <Link to="/runs/$runId" params={{ runId: item.runId }}>
                    {item.taskKey}
                  </Link>
                </td>
                <td>{item.agent}</td>
                <td>{item.credential ?? "—"}</td>
                <td>{t.labels.queueWaitingReason[item.waitingReason]}</td>
                <td>{formatTime(item.queuedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
