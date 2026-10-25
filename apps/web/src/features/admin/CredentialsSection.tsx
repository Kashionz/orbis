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
import { Button } from "../../components/Button";
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
  const t = useT();
  const { data: credentials = [], error, isSuccess } = useQuery(credentialsQuery);
  return (
    <section className="section" aria-labelledby="admin-credentials">
      <h2 id="admin-credentials">{t.admin.credentials}</h2>
      <ErrorText error={error} />
      {isSuccess && credentials.length === 0 && <p className="empty">{t.admin.noCredentials}</p>}
      {credentials.length > 0 && (
        <table className="run-table credential-table">
          <thead>
            <tr>
              <th scope="col">{t.admin.credentialColumns.credential}</th>
              <th scope="col">{t.admin.credentialColumns.runner}</th>
              <th scope="col">{t.admin.credentialColumns.agent}</th>
              <th scope="col">{t.admin.credentialColumns.concurrency}</th>
              <th scope="col">{t.admin.credentialColumns.queued}</th>
              <th scope="col">{t.admin.credentialColumns.rateLimit}</th>
              <th scope="col">{t.admin.credentialColumns.last24h}</th>
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
          {c.online ? "" : t.admin.offlineSuffix}
        </span>
      </td>
      <td>{c.agents.join(t.common.listSeparator)}</td>
      <td data-testid="concurrency">
        {c.activeRuns} / {c.maxConcurrentRuns}
        {c.maxConcurrentRunsOverride !== null && (
          <span className="hint">{t.admin.overrideNote(c.reportedMaxConcurrentRuns)}</span>
        )}
        {canOverride && editing === null && (
          <button
            type="button"
            className="link-button"
            onClick={() => setEditing(String(c.maxConcurrentRuns))}
          >
            {t.admin.overrideLimit}
          </button>
        )}
        {canOverride && editing !== null && (
          <form
            className="inline-form"
            aria-label={t.admin.overrideFormLabel(c.credential)}
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) save.mutate(parsed);
            }}
          >
            <input
              type="number"
              min={1}
              max={1000}
              aria-label={t.admin.concurrencyLimit}
              value={editing}
              onChange={(event) => setEditing(event.target.value)}
            />
            <Button type="submit" variant="primary" disabled={!valid || save.isPending}>
              {t.common.save}
            </Button>
            {c.maxConcurrentRunsOverride !== null && (
              <Button disabled={save.isPending} onClick={() => save.mutate(null)}>
                {t.admin.clearOverride}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t.common.cancel}
            </Button>
          </form>
        )}
        <ErrorText error={save.error} />
      </td>
      <td>{c.queuedRuns}</td>
      <td>
        {c.rateLimitedUntil ? (
          <span className="tag rate-limited">
            {t.admin.rateLimitedUntil(formatTime(c.rateLimitedUntil))}
          </span>
        ) : (
          t.admin.rateLimitNormal
        )}
      </td>
      <td>
        <span>{t.admin.usageRuns(c.usage24h.runs)}</span>{" "}
        <span>{t.admin.usageInput(tokens(c.usage24h.inputTokens))}</span>{" "}
        <span>{t.admin.usageOutput(tokens(c.usage24h.outputTokens))}</span>
        {c.usage24h.cost && (
          <>
            {" "}
            <span>
              {c.usage24h.cost.currency} {c.usage24h.cost.amount.toFixed(2)}
            </span>
          </>
        )}
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
      <h2 id="admin-queue">{t.admin.queue}</h2>
      <ErrorText error={error} />
      {isSuccess && queue.length === 0 && <p className="empty">{t.admin.queueEmpty}</p>}
      {queue.length > 0 && (
        <table className="run-table queue-table">
          <thead>
            <tr>
              <th scope="col">{t.admin.queueColumns.position}</th>
              <th scope="col">{t.admin.queueColumns.task}</th>
              <th scope="col">{t.admin.queueColumns.agent}</th>
              <th scope="col">{t.admin.queueColumns.credential}</th>
              <th scope="col">{t.admin.queueColumns.reason}</th>
              <th scope="col">{t.admin.queueColumns.queuedAt}</th>
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
