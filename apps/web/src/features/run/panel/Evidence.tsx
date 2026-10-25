// Verification 結果的證據：指令輸出、截圖、操作紀錄、文字。不認得的種類略過（協定允許之後增加）。

import type { TextBody, VerificationEvidence } from "@orbis/protocol";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { blobTextQuery, blobUrl } from "../../../api/resources";
import { ErrorText } from "../../../components/ErrorText";
import { useT } from "../../../i18n";

export function EvidenceView({ evidence }: { evidence: VerificationEvidence }) {
  const t = useT();
  const e = t.workspace.task.evidence;
  switch (evidence.type) {
    case "command_output":
      return (
        <div className="rp-evidence rp-evidence-term" data-evidence="command_output">
          <div className="rp-term-cmd">$ {evidence.command}</div>
          <TextBodyView body={evidence.output} />
          <div className="rp-muted">
            {evidence.exit_code === null ? e.interrupted : e.exitCode(evidence.exit_code)}
            {evidence.truncated && ` ${e.truncated}`}
          </div>
        </div>
      );
    case "screenshot":
      return (
        <figure className="rp-evidence rp-evidence-shot" data-evidence="screenshot">
          <img src={blobUrl(evidence.image.blob_id)} alt={evidence.caption ?? e.screenshot} />
          {(evidence.caption || evidence.url) && (
            <figcaption>
              {evidence.caption}
              {evidence.url && <span className="rp-mono-muted"> {evidence.url}</span>}
            </figcaption>
          )}
        </figure>
      );
    case "action_log":
      return (
        <div className="rp-evidence" data-evidence="action_log">
          <span className="rp-muted">{e.actions}</span>
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
        <p className="rp-evidence" data-evidence="text">
          {evidence.text}
        </p>
      );
    default:
      return null;
  }
}

/** 指令輸出：內嵌的直接顯示，放在 blob 的按下才讀取。 */
function TextBodyView({ body }: { body: TextBody }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const blobId = body.type === "blob" ? body.blob_id : null;
  const blob = useQuery({ ...blobTextQuery(blobId ?? ""), enabled: blobId !== null && open });
  if (body.type === "inline") return <pre className="rp-term-out">{body.text}</pre>;
  if (!open) {
    return (
      <button type="button" className="rp-link" onClick={() => setOpen(true)}>
        {t.workspace.task.evidence.showOutput(body.size.toLocaleString())}
      </button>
    );
  }
  return (
    <>
      <pre className="rp-term-out">{blob.data ?? t.common.loading}</pre>
      <ErrorText error={blob.error} />
    </>
  );
}
