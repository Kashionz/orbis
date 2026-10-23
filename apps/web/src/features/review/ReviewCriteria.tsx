import type { AcceptanceCriterion } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  acceptanceCriteriaQuery,
  checkAcceptanceCriterion,
  queryKeys,
  verificationsQuery,
} from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { AC_KIND_LABELS, AC_RESULT_LABELS } from "../../lib/labels";

/** 還沒打勾的 `manual` 條件（全部打勾後才能核准 Review Gate，§5.1）。 */
export function uncheckedManualCriteria(
  criteria: readonly AcceptanceCriterion[],
): AcceptanceCriterion[] {
  return criteria.filter((c) => c.kind === "manual" && c.result !== "passed");
}

/**
 * Review Gate 中的 Acceptance Criterion：Verification 的最新結果（略過的失敗也看得到），
 * 以及 `manual` 條件的打勾。
 */
export function ReviewCriteria({
  taskId,
  runId,
  canCheck,
}: {
  taskId: string;
  runId: string;
  canCheck: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: criteria = [], error } = useQuery(acceptanceCriteriaQuery(taskId));
  const { data: verifications = [] } = useQuery(verificationsQuery(runId));
  const skipped = verifications.at(-1)?.resolution === "skip";
  // 送出中的打勾先顯示在畫面上；失敗時回到 Server 的值
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const check = useMutation({
    mutationFn: ({ id, checked }: { id: string; checked: boolean }) =>
      checkAcceptanceCriterion(id, checked),
    onSettled: (_data, _error, { id }) =>
      setPending((current) => {
        const { [id]: _, ...rest } = current;
        return rest;
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        queryKeys.acceptanceCriteria(taskId),
        (current: AcceptanceCriterion[] | undefined) =>
          current?.map((c) => (c.id === updated.id ? updated : c)),
      );
    },
  });

  if (criteria.length === 0 && !error) return null;
  return (
    <section className="review-criteria" aria-labelledby="review-criteria-heading">
      <h2 id="review-criteria-heading">Acceptance Criterion</h2>
      {skipped && (
        <p className="notice-inline" role="note">
          Verification 有失敗的條件，已選擇略過，進入 Review Gate。
        </p>
      )}
      <ErrorText error={error ?? check.error} />
      <ul>
        {criteria.map((criterion) => (
          <li key={criterion.id} data-kind={criterion.kind} data-result={criterion.result}>
            {criterion.kind === "manual" ? (
              <label>
                <input
                  type="checkbox"
                  checked={pending[criterion.id] ?? criterion.result === "passed"}
                  disabled={!canCheck || criterion.id in pending}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setPending((current) => ({ ...current, [criterion.id]: checked }));
                    check.mutate({ id: criterion.id, checked });
                  }}
                />{" "}
                {criterion.description}
              </label>
            ) : (
              <>
                <span className="status-badge" data-status={criterion.result}>
                  {AC_RESULT_LABELS[criterion.result]}
                </span>{" "}
                {criterion.description}
              </>
            )}
            <span className="tag">{AC_KIND_LABELS[criterion.kind]}</span>
            {criterion.kind !== "manual" && criterion.resultSummary && (
              <span className="hint"> {criterion.resultSummary}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
