import type {
  AcceptanceCriterion,
  Verification,
  VerificationDecisionInput,
  VerificationResultItem,
} from "@orbis/api-contract";
import type { TextBody, VerificationEvidence } from "@orbis/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  acceptanceCriteriaQuery,
  blobTextQuery,
  blobUrl,
  decideVerification,
  queryKeys,
  verificationsQuery,
} from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { useT } from "../../i18n";
import { formatTime } from "../../lib/format";

interface VerificationPanelProps {
  runId: string;
  taskId: string;
  /** Project 的自動重試上限（`ProjectPolicy.verificationMaxRetries`）。 */
  maxRetries: number;
  /** 超過重試上限時能不能做決定（再試、中止）。 */
  canDecide: boolean;
  /** 能不能略過失敗、進入 Review Gate（和核准 Gate 的權限相同）。 */
  canSkip: boolean;
}

/**
 * Verification 結果（ARCHITECTURE §5.1）：每一輪逐條顯示結果與證據、重試次數；
 * 超過重試上限、停在 Verifying 時，由人選擇附意見再試、略過失敗進入 Review Gate，或中止。
 */
export function VerificationPanel({
  runId,
  taskId,
  maxRetries,
  canDecide,
  canSkip,
}: VerificationPanelProps) {
  const { data: verifications = [], error } = useQuery({
    ...verificationsQuery(runId),
    // 進行中時持續更新（結果由 verification_result Event 逐條寫入）
    refetchInterval: (query) =>
      query.state.data?.some((v) => v.status === "running") ? 2_000 : false,
  });
  const { data: criteria = [] } = useQuery(acceptanceCriteriaQuery(taskId));
  const latest = verifications.at(-1);

  return (
    <section className="verification-panel" aria-label="Verification 結果">
      <ErrorText error={error} />
      {verifications.length === 0 && <p className="empty">這個 Run 還沒有 Verification。</p>}
      {latest?.awaitingDecision && canDecide && (
        <VerificationDecisionForm
          runId={runId}
          taskId={taskId}
          verification={latest}
          canSkip={canSkip}
        />
      )}
      {latest?.awaitingDecision && !canDecide && (
        <p className="notice-inline">Verification 超過重試上限，等待有權限的 Member 決定。</p>
      )}
      <ol className="verification-rounds" reversed>
        {[...verifications].reverse().map((verification) => (
          <VerificationRound
            key={verification.id}
            verification={verification}
            criteria={criteria}
            maxRetries={maxRetries}
          />
        ))}
      </ol>
    </section>
  );
}

function VerificationRound({
  verification,
  criteria,
  maxRetries,
}: {
  verification: Verification;
  criteria: readonly AcceptanceCriterion[];
  maxRetries: number;
}) {
  const t = useT();
  const byId = new Map(criteria.map((c) => [c.id, c]));
  return (
    <li
      className="verification-round"
      data-status={verification.status}
      data-testid={`verification-${verification.attempt}`}
    >
      <header className="verification-header">
        <strong>第 {verification.attempt} 輪</strong>
        <span className="status-badge" data-status={verification.status}>
          {t.labels.verificationStatus[verification.status]}
        </span>
        <span className="hint">
          已自動重試 {verification.attempt - 1} 次／上限 {maxRetries} 次
        </span>
        <span className="hint">{formatTime(verification.startedAt)}</span>
        {verification.resolution && (
          <span className="tag">
            人的決定：{t.labels.verificationResolution[verification.resolution]}
          </span>
        )}
      </header>
      {verification.comment && <p className="hint">意見：{verification.comment}</p>}
      <ul className="verification-results">
        {verification.results.map((result) => (
          <ResultView
            key={result.criterionId}
            result={result}
            criterion={byId.get(result.criterionId)}
          />
        ))}
      </ul>
      {verification.status === "running" && <p className="hint">檢查中…</p>}
    </li>
  );
}

function ResultView({
  result,
  criterion,
}: {
  result: VerificationResultItem;
  criterion: AcceptanceCriterion | undefined;
}) {
  const t = useT();
  return (
    <li className="verification-result" data-outcome={result.outcome}>
      <div className="verification-result-header">
        <span className="status-badge" data-status={result.outcome}>
          {t.labels.verificationOutcome[result.outcome]}
        </span>
        <span>{criterion?.description ?? "（已刪除的條件）"}</span>
        {criterion && <span className="tag">{t.labels.acKind[criterion.kind]}</span>}
      </div>
      <p className="verification-summary">{result.summary}</p>
      {result.judgedByRunId && (
        <Link to="/runs/$runId" params={{ runId: result.judgedByRunId }}>
          判定的 Agent Run
        </Link>
      )}
      {result.evidence.map((evidence, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 證據沒有 id，順序固定
        <EvidenceView key={index} evidence={evidence} />
      ))}
    </li>
  );
}

/** 一則證據。不認得的種類略過（協定允許之後增加）。 */
export function EvidenceView({ evidence }: { evidence: VerificationEvidence }) {
  switch (evidence.type) {
    case "command_output":
      return (
        <div className="terminal evidence" data-evidence="command_output">
          <div className="terminal-command">$ {evidence.command}</div>
          <TextBodyView body={evidence.output} />
          <div className="hint">
            {evidence.exit_code === null ? "被中斷或逾時" : `exit code ${evidence.exit_code}`}
            {evidence.truncated && "（輸出只保留最後一段）"}
          </div>
        </div>
      );
    case "screenshot":
      return (
        <figure className="evidence" data-evidence="screenshot">
          <img
            src={blobUrl(evidence.image.blob_id)}
            alt={evidence.caption ?? "Verification 的截圖"}
          />
          <figcaption>
            {evidence.caption}
            {evidence.url && <span className="hint"> {evidence.url}</span>}
          </figcaption>
        </figure>
      );
    case "action_log":
      return (
        <div className="evidence" data-evidence="action_log">
          <strong>操作紀錄</strong>
          <ol>
            {evidence.steps.map((step, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 步驟沒有 id
              <li key={index}>{step}</li>
            ))}
          </ol>
        </div>
      );
    case "text":
      return (
        <p className="evidence" data-evidence="text">
          {evidence.text}
        </p>
      );
    default:
      return null;
  }
}

/** 指令輸出：內嵌的直接顯示，放在 blob 的按下才讀取。 */
function TextBodyView({ body }: { body: TextBody }) {
  const [open, setOpen] = useState(false);
  const blobId = body.type === "blob" ? body.blob_id : null;
  const blob = useQuery({ ...blobTextQuery(blobId ?? ""), enabled: blobId !== null && open });
  if (body.type === "inline") return <pre>{body.text}</pre>;
  if (!open) {
    return (
      <button type="button" className="link-button" onClick={() => setOpen(true)}>
        顯示輸出（{body.size.toLocaleString()} bytes）
      </button>
    );
  }
  return (
    <>
      <pre>{blob.data ?? "讀取中…"}</pre>
      <ErrorText error={blob.error} />
    </>
  );
}

function VerificationDecisionForm({
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
      className="gate-panel verification-decision"
      aria-label="Verification 的決定"
      onSubmit={(event) => {
        event.preventDefault();
        decide.mutate({ action: "retry", comment: comment.trim() === "" ? null : comment.trim() });
      }}
    >
      <h3>Verification 連續失敗 {verification.attempt} 輪，超過重試上限</h3>
      <p className="hint">
        選擇怎麼處理：附上意見再試一次（重試次數重新計算）、略過失敗進入 Review Gate，或中止 Run。
      </p>
      <label className="field">
        給 Agent 的意見（選填）
        <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <ErrorText error={decide.error} />
      <div className="form-actions">
        <button type="submit" className="primary" disabled={decide.isPending}>
          附意見再試
        </button>
        {canSkip && (
          <button
            type="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ action: "skip" })}
          >
            略過失敗，進入 Review Gate
          </button>
        )}
        <button
          type="button"
          className="danger"
          disabled={decide.isPending}
          onClick={() => decide.mutate({ action: "abort" })}
        >
          中止 Run
        </button>
      </div>
    </form>
  );
}
