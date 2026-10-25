// Task 分頁的驗收紀錄：每一輪的狀態、重試次數、人的決定；超過重試上限時的決定表單
// （附意見再試、略過失敗進入審查關卡、中止）。`?tab=verification` 捲到這裡。

import type { Verification, VerificationDecisionInput } from "@orbis/api-contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { decideVerification, queryKeys } from "../../../api/resources";
import { ErrorText } from "../../../components/ErrorText";
import { useT } from "../../../i18n";
import { formatTime } from "../../../lib/format";
import { VERIFICATION_FOCUS } from "../workspace/route-state";

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
          <li
            key={verification.id}
            className="rp-round"
            data-status={verification.status}
            data-testid={`verification-${verification.attempt}`}
          >
            <span className="rp-round-title">{w.round(verification.attempt)}</span>
            <span className="rp-round-status" data-status={verification.status}>
              {t.labels.verificationStatus[verification.status]}
            </span>
            <span className="rp-muted">{w.retries(verification.attempt - 1, maxRetries)}</span>
            <span className="rp-mono-muted">{formatTime(verification.startedAt)}</span>
            {verification.resolution && (
              <span className="rp-muted">
                {w.resolution(t.labels.verificationResolution[verification.resolution])}
              </span>
            )}
            {verification.comment && (
              <span className="rp-round-comment">{w.commentLabel(verification.comment)}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
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
