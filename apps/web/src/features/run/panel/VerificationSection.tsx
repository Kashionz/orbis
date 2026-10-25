// Task 分頁的驗收紀錄：每一輪的狀態、重試次數、人的決定；超過重試上限時的決定表單
// （附意見再試、略過失敗進入審查關卡、中止）。`?tab=verification` 捲到這裡。

import type {
  AcceptanceCriterion,
  Verification,
  VerificationDecisionInput,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { acceptanceCriteriaQuery, decideVerification, queryKeys } from "../../../api/resources";
import { ErrorText } from "../../../components/ErrorText";
import { useT } from "../../../i18n";
import { formatTime } from "../../../lib/format";
import { VERIFICATION_FOCUS } from "../workspace/route-state";
import { EvidenceView } from "./Evidence";

interface VerificationSectionProps {
  runId: string;
  taskId: string;
  verifications: readonly Verification[];
  maxRetries: number;
  canDecide: boolean;
  canSkip: boolean;
}

export function VerificationSection({
  runId,
  taskId,
  verifications,
  maxRetries,
  canDecide,
  canSkip,
}: VerificationSectionProps) {
  const t = useT();
  const w = t.workspace.task;
  const latest = verifications.at(-1);
  const { data: criteria = [] } = useQuery(acceptanceCriteriaQuery(taskId));
  if (verifications.length === 0) return null;
  return (
    <section
      className="rp-section"
      id={VERIFICATION_FOCUS}
      aria-labelledby="rp-verification-heading"
      data-testid="verification-section"
    >
      <h2 id="rp-verification-heading" className="rp-section-title">
        {w.verification}
      </h2>
      {latest?.awaitingDecision &&
        (canDecide ? (
          <DecisionForm runId={runId} taskId={taskId} verification={latest} canSkip={canSkip} />
        ) : (
          <p className="rp-notice">{w.decision.waiting}</p>
        ))}
      <ol className="rp-rounds" reversed>
        {[...verifications].reverse().map((verification) => (
          <Round
            key={verification.id}
            verification={verification}
            criteria={criteria}
            maxRetries={maxRetries}
            defaultOpen={verification === latest && verification.status !== "passed"}
          />
        ))}
      </ol>
    </section>
  );
}

function Round({
  verification,
  criteria,
  maxRetries,
  defaultOpen,
}: {
  verification: Verification;
  criteria: readonly AcceptanceCriterion[];
  maxRetries: number;
  defaultOpen: boolean;
}) {
  const t = useT();
  const w = t.workspace.task;
  const [open, setOpen] = useState(defaultOpen);
  const byId = new Map(criteria.map((c) => [c.id, c]));
  return (
    <li
      className="rp-round"
      data-status={verification.status}
      data-testid={`verification-${verification.attempt}`}
    >
      <button
        type="button"
        className="rp-round-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="rp-round-title">{w.round(verification.attempt)}</span>
        <span className="rp-round-status" data-status={verification.status}>
          {t.labels.verificationStatus[verification.status]}
        </span>
        <span className="rp-muted">{w.retries(verification.attempt - 1, maxRetries)}</span>
        <span className="rp-mono-muted">{formatTime(verification.startedAt)}</span>
        <span className="st-chevron" data-open={open} aria-hidden="true">
          ›
        </span>
      </button>
      {verification.resolution && (
        <span className="rp-muted">
          {w.resolution(t.labels.verificationResolution[verification.resolution])}
        </span>
      )}
      {verification.comment && (
        <span className="rp-round-comment">{w.commentLabel(verification.comment)}</span>
      )}
      {open && (
        <ul className="rp-results">
          {verification.results.map((result) => {
            const criterion = byId.get(result.criterionId);
            return (
              <li key={result.criterionId} className="rp-result" data-outcome={result.outcome}>
                <div className="rp-result-head">
                  <span
                    className="rp-glyph"
                    data-result={result.outcome === "passed" ? "passed" : "failed"}
                  >
                    {result.outcome === "passed" ? "✓" : "✕"}
                  </span>
                  <span className="rp-result-desc">
                    {criterion?.description ?? t.workspace.stream.deletedCriterion}
                  </span>
                  <span className="rp-result-outcome">
                    {t.labels.verificationOutcome[result.outcome]}
                  </span>
                </div>
                {result.summary && <p className="rp-muted rp-result-summary">{result.summary}</p>}
                {result.evidence.map((evidence, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 證據沒有 id，順序固定
                  <EvidenceView key={index} evidence={evidence} />
                ))}
                {result.judgedByRunId && (
                  <Link
                    to="/runs/$runId"
                    params={{ runId: result.judgedByRunId }}
                    className="rp-link"
                  >
                    {w.judgedBy}
                  </Link>
                )}
              </li>
            );
          })}
          {verification.status === "running" && <li className="rp-muted">{w.checking}</li>}
        </ul>
      )}
    </li>
  );
}

function DecisionForm({
  runId,
  taskId,
  verification,
  canSkip,
}: {
  runId: string;
  taskId: string;
  verification: Verification;
  canSkip: boolean;
}) {
  const t = useT();
  const d = t.workspace.task.decision;
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const decide = useMutation({
    mutationFn: (input: VerificationDecisionInput) => decideVerification(runId, input),
    onSuccess: async () => {
      setComment("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.verifications(runId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.taskGates(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.needsYou }),
      ]);
    },
  });
  return (
    <form
      className="rp-decision"
      aria-label={d.title(verification.attempt)}
      onSubmit={(event) => {
        event.preventDefault();
        decide.mutate({ action: "retry", comment: comment.trim() === "" ? null : comment.trim() });
      }}
    >
      <span className="rp-decision-title">{d.title(verification.attempt)}</span>
      <textarea
        className="rp-textarea"
        rows={3}
        aria-label={d.comment}
        placeholder={d.comment}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
      <ErrorText error={decide.error} />
      <div className="rp-actions">
        <button type="submit" className="o-btn" data-variant="primary" disabled={decide.isPending}>
          {d.retry}
        </button>
        {canSkip && (
          <button
            type="button"
            className="o-btn"
            data-variant="secondary"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ action: "skip" })}
          >
            {d.skip}
          </button>
        )}
        <button
          type="button"
          className="o-btn"
          data-variant="danger-ghost"
          disabled={decide.isPending}
          onClick={() => decide.mutate({ action: "abort" })}
        >
          {d.abort}
        </button>
      </div>
    </form>
  );
}
