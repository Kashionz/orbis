// Task 分頁的驗收條件（檢視模式）：狀態符號、描述、類型、指令、結果。點一列展開最近一次的判定摘要、
// 證據、判定的 Run，以及描述的即時共同編輯。

import type { AcceptanceCriterion, Verification } from "@orbis/api-contract";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { queryKeys } from "../../../api/resources";
import { useT } from "../../../i18n";
import { CollabEditor } from "../../collab/CollabEditor";
import { EvidenceView } from "./Evidence";

export const RESULT_GLYPH = { pending: "○", passed: "✓", failed: "✕" } as const;

interface AcceptanceListProps {
  criteria: readonly AcceptanceCriterion[];
  verifications: readonly Verification[];
  projectId: string;
  canEdit: boolean;
}

export function AcceptanceList({
  criteria,
  verifications,
  projectId,
  canEdit,
}: AcceptanceListProps) {
  const t = useT();
  const w = t.workspace.task;
  const passed = criteria.filter((c) => c.result === "passed").length;
  return (
    <section className="rp-section" aria-labelledby="rp-criteria-heading">
      <div className="rp-section-head">
        <h2 id="rp-criteria-heading" className="rp-section-title">
          {w.criteria}
        </h2>
        {criteria.length > 0 && (
          <span className="rp-mono-muted">
            {passed}/{criteria.length}
          </span>
        )}
      </div>
      {criteria.length === 0 && <span className="rp-muted">{w.noCriteria}</span>}
      <ul className="rp-criteria">
        {[...criteria]
          .sort((a, b) => a.position - b.position)
          .map((criterion) => (
            <CriterionRow
              key={criterion.id}
              criterion={criterion}
              verifications={verifications}
              projectId={projectId}
              canEdit={canEdit}
            />
          ))}
      </ul>
    </section>
  );
}

function CriterionRow({
  criterion,
  verifications,
  projectId,
  canEdit,
}: {
  criterion: AcceptanceCriterion;
  verifications: readonly Verification[];
  projectId: string;
  canEdit: boolean;
}) {
  const t = useT();
  const w = t.workspace.task;
  const [open, setOpen] = useState(false);
  const [collab, setCollab] = useState(false);
  const queryClient = useQueryClient();
  const latest = [...verifications]
    .reverse()
    .flatMap((v) => v.results)
    .find((r) => r.criterionId === criterion.id);
  return (
    <li className="rp-criterion" data-kind={criterion.kind} data-result={criterion.result}>
      <button
        type="button"
        className="rp-criterion-row"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="rp-glyph" data-result={criterion.result}>
          {RESULT_GLYPH[criterion.result]}
        </span>
        <span className="rp-criterion-main">
          <span className="rp-criterion-desc">{criterion.description}</span>
          <span className="rp-criterion-meta">
            <span className="rp-mono">{t.labels.acKind[criterion.kind]}</span>
            {criterion.kind === "command" && (
              <span className="rp-mono rp-ellipsis">{criterion.command ?? w.commandInherited}</span>
            )}
            <span className="rp-criterion-result" data-result={criterion.result}>
              {t.labels.acResult[criterion.result]}
            </span>
          </span>
        </span>
      </button>
      {open && (
        <div className="rp-criterion-detail">
          {criterion.resultSummary && <p className="rp-muted">{criterion.resultSummary}</p>}
          {latest?.evidence.map((evidence, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 證據沒有 id，順序固定
            <EvidenceView key={index} evidence={evidence} />
          ))}
          {latest?.judgedByRunId && (
            <Link to="/runs/$runId" params={{ runId: latest.judgedByRunId }} className="rp-link">
              {w.judgedBy}
            </Link>
          )}
          <button
            type="button"
            className="rp-link"
            aria-expanded={collab}
            onClick={() => {
              // 結束共同編輯時，描述已由 Server 回寫，重新取得清單
              if (collab) {
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.acceptanceCriteria(criterion.taskId),
                });
              }
              setCollab(!collab);
            }}
          >
            {collab ? w.collabEnd : canEdit ? w.collabEdit : w.collabView}
          </button>
          {collab && (
            <div className="rp-collab">
              <CollabEditor
                docRef={{ kind: "acceptance-criterion", id: criterion.id }}
                label={w.criterionLabel(criterion.description)}
                canEdit={canEdit}
                projectId={projectId}
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}
