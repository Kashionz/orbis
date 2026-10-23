import type { Gate } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Markdown from "react-markdown";
import { blobTextQuery, decideGate, queryKeys, runEventQuery } from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { PLAN_SOURCE_LABELS } from "../../lib/labels";

interface PlanGatePanelProps {
  gate: Gate;
  runId: string;
  canApprove: boolean;
  canReject: boolean;
  canAbort: boolean;
}

/**
 * Plan Gate（ARCHITECTURE §5）：顯示 Agent 提出的 plan（`Gate.planSeq` 的 `plan_proposed`），
 * 可以核准、退回並附上意見，或中止 Run。
 */
export function PlanGatePanel({
  gate,
  runId,
  canApprove,
  canReject,
  canAbort,
}: PlanGatePanelProps) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const planSeq = gate.planSeq;
  const event = useQuery({ ...runEventQuery(runId, planSeq ?? 0), enabled: planSeq !== null });
  const plan = event.data?.event.kind === "plan_proposed" ? event.data.event : null;
  const blobId = plan?.body.type === "blob" ? plan.body.blob_id : null;
  const blob = useQuery({ ...blobTextQuery(blobId ?? ""), enabled: blobId !== null });
  const text = plan?.body.type === "inline" ? plan.body.text : (blob.data ?? null);

  const decision = useMutation({
    mutationFn: (action: "approve" | "reject" | "abort") =>
      decideGate(gate.id, action === "reject" ? { action, comment: comment.trim() } : { action }),
    onSuccess: async () => {
      setComment("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.taskGates(gate.taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.needsYou }),
      ]);
    },
  });

  return (
    <section className="gate-panel plan-gate" aria-labelledby="plan-gate-heading">
      <h2 id="plan-gate-heading">Plan Gate：等待核准 plan</h2>
      {plan && <p className="hint">來源：{PLAN_SOURCE_LABELS[plan.source]}</p>}
      <div className="markdown plan-body" data-testid="plan-body">
        {text !== null ? <Markdown>{text}</Markdown> : <p className="hint">正在讀取 plan…</p>}
      </div>
      <ErrorText error={event.error ?? blob.error} />
      {canReject && (
        <label className="field">
          退回的意見
          <textarea
            rows={3}
            value={comment}
            placeholder="說明要怎麼修改 plan"
            onChange={(e) => setComment(e.target.value)}
          />
        </label>
      )}
      <ErrorText error={decision.error} />
      <div className="form-actions">
        {canApprove && (
          <button
            type="button"
            className="primary"
            disabled={decision.isPending}
            onClick={() => decision.mutate("approve")}
          >
            核准 plan
          </button>
        )}
        {canReject && (
          <button
            type="button"
            className="danger"
            disabled={decision.isPending || comment.trim() === ""}
            onClick={() => decision.mutate("reject")}
          >
            退回並附上意見
          </button>
        )}
        {canAbort && (
          <button
            type="button"
            disabled={decision.isPending}
            onClick={() => decision.mutate("abort")}
          >
            中止 Run
          </button>
        )}
      </div>
      {!canApprove && canReject && (
        <p className="hint">這個 Project 不允許你核准自己的 Task，可以退回或請其他人核准。</p>
      )}
    </section>
  );
}
