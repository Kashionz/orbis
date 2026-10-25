// 右側的差異分頁（README「Diff」）：base → branch、+/−、留言數、模式；檔案分頁；sticky 的檔案標頭；
// 行格（舊行號、新行號、+/−、內容），在審查關卡點一行留言；留言卡；人工確認的條件、預覽留言、
// 之前的退回；整體說明、退回、核准並開啟合併請求（diff 為空時改為結束（沒有變更））。
// 原本的 Monaco diff review 頁由這個分頁取代（協調者 Q1）。

import type {
  AcceptanceCriterion,
  Gate,
  ReviewCommentInput,
  ReviewDiff,
  ReviewDiffFile,
  Run,
  TextBody,
} from "@orbis/api-contract";
import { TERMINAL_RUN_STATUSES } from "@orbis/protocol";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { GitPullRequest } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  acceptanceCriteriaQuery,
  blobTextQuery,
  blobUrl,
  checkAcceptanceCriterion,
  decideGate,
  queryKeys,
  verificationsQuery,
} from "../../../api/resources";
import { Avatar } from "../../../components/Avatar";
import { ErrorText } from "../../../components/ErrorText";
import { FluidList, fluidItem } from "../../../components/FluidList";
import { useT } from "../../../i18n";
import { formatTime } from "../../../lib/format";
import { meQueryOptions } from "../../auth/api";
import type { Permissions } from "../../auth/use-permissions";
import { MentionMarkdown } from "../../mention/MentionMarkdown";
import { MentionTextarea } from "../../mention/MentionTextarea";
import {
  clearPreviewDrafts,
  loadPreviewDrafts,
  savePreviewDrafts,
  subscribePreviewDrafts,
} from "../../preview/preview-drafts";
import { loadDraft, type ReviewDraft, saveDraft, sortComments } from "../../review/review-drafts";
import { ConsultRunLinks } from "../../task/TaskComments";
import {
  baseName,
  type CodeRow,
  changeLetter,
  commentAnchor,
  diffRows,
  placeComments,
} from "./diff-lines";

interface DiffTabProps {
  run: Run;
  status: Run["status"];
  diff: ReviewDiff | null;
  reviewGate: Gate | null;
  gates: readonly Gate[];
  projectId: string;
  permissions: Permissions;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
}

/** 檔案某一側的內容：內嵌的直接用，放在 blob 的向 Server 取得。不存在的一側為空字串。 */
export function useTextBody(body: TextBody | null): { text: string | null; error: unknown } {
  const blobId = body?.type === "blob" ? body.blob_id : null;
  const blob = useQuery({ ...blobTextQuery(blobId ?? ""), enabled: blobId !== null });
  if (body === null) return { text: "", error: null };
  if (body.type === "inline") return { text: body.text, error: null };
  return { text: blob.data ?? null, error: blob.error };
}

export function DiffTab(props: DiffTabProps) {
  // 換了 Gate（退回後的新一輪）時草稿重新讀取
  return <DiffTabInner key={`${props.run.id}-${props.reviewGate?.id ?? "none"}`} {...props} />;
}

function DiffTabInner({
  run,
  status,
  diff,
  reviewGate,
  gates,
  projectId,
  permissions,
  selectedPath,
  onSelectPath,
}: DiffTabProps) {
  const t = useT();
  const w = t.workspace.diff;
  const queryClient = useQueryClient();
  const [draft, setDraftState] = useState<ReviewDraft>(() => loadDraft(run.id));
  const [previewDrafts, setPreviewDrafts] = useState(() => loadPreviewDrafts(run.id));
  useEffect(
    () => subscribePreviewDrafts(run.id, () => setPreviewDrafts(loadPreviewDrafts(run.id))),
    [run.id],
  );
  const { data: criteria = [] } = useQuery(acceptanceCriteriaQuery(run.taskId));
  const { data: verifications = [] } = useQuery(verificationsQuery(run.id));
  const reviewing = reviewGate !== null && status === "awaiting_gate";
  const canReject = reviewing && permissions.can("gate.reject");
  const canApprove = reviewing && permissions.can("gate.approve");
  const terminal = (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
  const files = diff?.files ?? [];
  const empty = diff !== null && files.length === 0;
  const file = files.find((f) => f.path === selectedPath) ?? files[0] ?? null;
  const unchecked = criteria.filter((c) => c.kind === "manual" && c.result !== "passed");
  const previous = gates.filter(
    (g) => g.runId === run.id && g.kind === "review" && g.decision === "rejected",
  );
  const finished = gates.some((g) => g.runId === run.id && g.finishedWithoutChanges);

  function setDraft(next: ReviewDraft) {
    setDraftState(next);
    saveDraft(run.id, next);
  }

  const decision = useMutation({
    mutationFn: async (action: "approve" | "finish_without_changes" | "reject") => {
      if (!reviewGate) return;
      await decideGate(
        reviewGate.id,
        action !== "reject"
          ? { action }
          : {
              action: "reject",
              comment: draft.summary.trim() === "" ? null : draft.summary.trim(),
              reviewComments: sortComments(draft.comments),
              previewComments: previewDrafts,
            },
      );
    },
    onSuccess: async () => {
      setDraft({ comments: [], summary: "" });
      clearPreviewDrafts(run.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.run(run.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.taskGates(run.taskId) }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.needsYou }),
      ]);
    },
  });

  const stats = useDiffStats(files);
  const commentCount = draft.comments.length + previewDrafts.length;
  const canSendRejection = commentCount > 0 || draft.summary.trim() !== "";
  const mode = reviewing ? w.modeReview : terminal ? w.modeReadOnly : w.modeLive;

  return (
    <div className="rp-diff">
      <div className="rp-diff-bar">
        {diff && (
          <span>
            {diff.baseCommit.slice(0, 7)} → {run.branch ?? ""}
          </span>
        )}
        <span className="rp-diff-stats">
          <span className="st-add">+{stats.adds}</span>
          <span className="st-del">−{stats.dels}</span>
        </span>
        {draft.comments.length > 0 && <span>{w.comments(draft.comments.length)}</span>}
        <span className="rp-spacer" />
        <span className="rp-diff-mode" data-review={reviewing}>
          {mode}
        </span>
      </div>

      {!diff && <div className="rp-empty">{w.noDiff}</div>}
      {empty && (
        <EmptyDiff
          reviewing={reviewing}
          finished={finished}
          finalMessage={diff?.finalMessage ?? null}
        />
      )}

      {files.length > 0 && (
        <FluidList axis="x" className="rp-file-tabs" aria-label={w.files}>
          {files.map((f) => {
            const selected = f.path === file?.path;
            const commented = draft.comments.some((c) => c.path === f.path);
            return (
              <button
                key={f.path}
                type="button"
                className="rp-file-tab"
                aria-current={selected ? "true" : undefined}
                data-change={f.change}
                data-tip={f.path}
                data-tip-mono=""
                {...fluidItem}
                onClick={() => onSelectPath(f.path)}
              >
                <span className="rp-file-letter" data-change={f.change}>
                  {changeLetter(f.change)}
                </span>
                {baseName(f.path)}
                {commented && <span className="rp-file-dot" />}
              </button>
            );
          })}
        </FluidList>
      )}

      <div className="rp-diff-scroll">
        {file && (
          <FileView
            key={file.path}
            file={file}
            projectId={projectId}
            comments={draft.comments.filter((c) => c.path === file.path)}
            canComment={canReject}
            onAdd={(comment) => setDraft({ ...draft, comments: [...draft.comments, comment] })}
            onRemove={(comment) =>
              setDraft({ ...draft, comments: draft.comments.filter((c) => c !== comment) })
            }
          />
        )}

        {reviewing && criteria.some((c) => c.kind === "manual") && (
          <ManualChecks
            taskId={run.taskId}
            criteria={criteria}
            canCheck={canApprove}
            skipped={verifications.at(-1)?.resolution === "skip"}
          />
        )}

        {previewDrafts.length > 0 && (
          <section className="rp-diff-section" aria-labelledby="rp-preview-drafts">
            <h3 id="rp-preview-drafts" className="rp-section-title">
              {w.previewComments(previewDrafts.length)}
            </h3>
            <ul className="rp-comment-list">
              {previewDrafts.map((comment, index) => (
                <li
                  key={comment.screenshotBlobId ?? `${comment.url}|${comment.body}`}
                  className="rp-comment"
                >
                  <span className="rp-mono-muted rp-ellipsis">
                    {comment.url}
                    {comment.selector && ` ${comment.selector}`}
                  </span>
                  <div className="rp-comment-body">{comment.body}</div>
                  {comment.screenshotBlobId && (
                    <img
                      className="rp-comment-shot"
                      src={blobUrl(comment.screenshotBlobId)}
                      alt={w.previewShot}
                    />
                  )}
                  {canReject && (
                    <button
                      type="button"
                      className="rp-text-btn"
                      data-danger="true"
                      onClick={() =>
                        savePreviewDrafts(
                          run.id,
                          previewDrafts.filter((_, i) => i !== index),
                        )
                      }
                    >
                      {w.deletePreviewComment}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {previous.length > 0 && <PreviousReviews gates={previous} />}
        <div className="rp-diff-end" />
      </div>

      {(canReject || canApprove) && (
        <div className="rp-review-footer">
          {canApprove && unchecked.length > 0 && (
            <span className="rp-review-hint" role="note">
              {w.uncheckedManual(unchecked.length)}
            </span>
          )}
          <div className="rp-review-actions">
            {canReject && (
              <input
                className="rp-summary"
                aria-label={w.summary}
                placeholder={w.summary}
                value={draft.summary}
                onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
              />
            )}
            {canReject && (
              <button
                type="button"
                className="o-btn"
                data-variant="danger-ghost"
                disabled={!canSendRejection || decision.isPending}
                onClick={() => decision.mutate("reject")}
              >
                {w.reject(commentCount)}
              </button>
            )}
            {canApprove && (
              <button
                type="button"
                className="o-btn"
                data-variant="primary"
                disabled={decision.isPending || unchecked.length > 0}
                onClick={() => decision.mutate(empty ? "finish_without_changes" : "approve")}
              >
                {!empty && <GitPullRequest size={14} strokeWidth={1.75} aria-hidden="true" />}
                {empty ? w.finish : w.approve}
              </button>
            )}
          </div>
          <ErrorText error={decision.error} />
        </div>
      )}
    </div>
  );
}

/** 所有檔案的 +/−（只算內嵌的內容）。 */
export function useDiffStats(files: readonly ReviewDiffFile[]) {
  return useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const file of files) {
      if (file.binary || file.old?.type === "blob" || file.new?.type === "blob") continue;
      const stats = diffRows(file.old?.text ?? "", file.new?.text ?? "");
      adds += stats.adds;
      dels += stats.dels;
    }
    return { adds, dels };
  }, [files]);
}

interface Target {
  index: number;
  side: "old" | "new";
  line: number;
}

function FileView({
  file,
  projectId,
  comments,
  canComment,
  onAdd,
  onRemove,
}: {
  file: ReviewDiffFile;
  projectId: string;
  comments: readonly ReviewCommentInput[];
  canComment: boolean;
  onAdd: (comment: ReviewCommentInput) => void;
  onRemove: (comment: ReviewCommentInput) => void;
}) {
  const t = useT();
  const w = t.workspace.diff;
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const before = useTextBody(file.binary ? null : file.old);
  const after = useTextBody(file.binary ? null : file.new);
  const [target, setTarget] = useState<Target | null>(null);
  const [body, setBody] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const ready = before.text !== null && after.text !== null;
  const { rows } = useMemo(
    () => (ready ? diffRows(before.text ?? "", after.text ?? "") : { rows: [] }),
    [ready, before.text, after.text],
  );
  const placed = useMemo(() => placeComments(rows, comments), [rows, comments]);
  const sideLabel = (side: "old" | "new") => (side === "new" ? w.newSide : w.oldSide);

  useEffect(() => {
    if (target) bodyRef.current?.focus();
  }, [target]);

  function submit() {
    if (!target || body.trim() === "") return;
    onAdd({ path: file.path, line: target.line, side: target.side, body: body.trim() });
    setTarget(null);
    setBody("");
  }

  const commentCard = (comment: ReviewCommentInput) => (
    <div key={`${comment.side}-${comment.line}-${comment.body}`} className="rp-comment">
      <div className="rp-comment-head">
        <Avatar person={{ name: me.githubLogin, avatarUrl: me.avatarUrl }} size={18} />
        <span className="rp-comment-author">{me.githubLogin}</span>
        <span className="rp-muted">{w.lineRef(sideLabel(comment.side), comment.line)}</span>
        {canComment && (
          <button
            type="button"
            className="rp-text-btn"
            data-danger="true"
            onClick={() => onRemove(comment)}
          >
            {w.deleteComment}
          </button>
        )}
      </div>
      <div className="rp-comment-body">
        <MentionMarkdown text={comment.body} />
      </div>
    </div>
  );

  return (
    <div className="rp-file" data-path={file.path}>
      <div className="rp-file-head">
        <span className="rp-ellipsis">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="rp-file-change">{t.labels.diffChange[file.change]}</span>
      </div>
      {file.binary && <div className="rp-empty">{w.binary}</div>}
      {!file.binary && (before.error || after.error) ? (
        <ErrorText error={before.error ?? after.error} />
      ) : null}
      {!file.binary && !ready && <div className="rp-empty">{w.loading}</div>}
      {placed.outside.length > 0 && (
        <div className="rp-comments-block">
          <span className="rp-muted">{w.outside}</span>
          {placed.outside.map(commentCard)}
        </div>
      )}
      <div className="rp-lines">
        {rows.map((row, index) => {
          if (row.kind === "hunk") {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: 行格依位置
              <div key={index} className="rp-hunk">
                {row.text}
              </div>
            );
          }
          const anchor = commentAnchor(row);
          const composing = target?.index === index;
          const rowComments = placed.byRow.get(index) ?? [];
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 行格依位置
            <Fragment key={index}>
              <CodeLine
                row={row}
                canComment={canComment}
                label={w.commentOn(sideLabel(anchor.side), anchor.line)}
                onClick={() => {
                  setTarget({ index, ...anchor });
                  setBody("");
                }}
              />
              {rowComments.length > 0 && (
                <div className="rp-comments-block">{rowComments.map(commentCard)}</div>
              )}
              {composing && target && (
                <form
                  className="rp-compose"
                  aria-label={w.commentOn(sideLabel(target.side), target.line)}
                  onSubmit={(event) => {
                    event.preventDefault();
                    submit();
                  }}
                >
                  <MentionTextarea
                    projectId={projectId}
                    textareaRef={bodyRef}
                    label={w.commentOn(sideLabel(target.side), target.line)}
                    rows={3}
                    placeholder={w.commentOn(sideLabel(target.side), target.line)}
                    value={body}
                    onChange={setBody}
                  />
                  <div className="rp-actions rp-actions-end">
                    <button
                      type="button"
                      className="o-btn"
                      data-variant="ghost"
                      onClick={() => setTarget(null)}
                    >
                      {t.common.cancel}
                    </button>
                    <button
                      type="submit"
                      className="o-btn"
                      data-variant="primary"
                      disabled={body.trim() === ""}
                    >
                      {w.addComment}
                    </button>
                  </div>
                </form>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function CodeLine({
  row,
  canComment,
  label,
  onClick,
}: {
  row: CodeRow;
  canComment: boolean;
  label: string;
  onClick: () => void;
}) {
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : "";
  const cells = (
    <>
      <span className="rp-line-num">{row.oldLine ?? ""}</span>
      <span className="rp-line-num">{row.newLine ?? ""}</span>
      <span className="rp-line-sign">{sign}</span>
      <span className="rp-line-text">{row.text}</span>
    </>
  );
  if (!canComment) {
    return (
      <div className="rp-line" data-kind={row.kind}>
        {cells}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="rp-line"
      data-kind={row.kind}
      aria-label={label}
      onClick={onClick}
    >
      {cells}
    </button>
  );
}

/** diff 為空時的說明與 Agent 最後的回覆（`final_message`）。 */
function EmptyDiff({
  reviewing,
  finished,
  finalMessage,
}: {
  reviewing: boolean;
  finished: boolean;
  finalMessage: TextBody | null;
}) {
  const t = useT();
  const w = t.workspace.diff;
  const reply = useTextBody(finalMessage);
  return (
    <section className="rp-diff-empty" aria-label={w.empty}>
      <span className="rp-empty-title">{w.empty}</span>
      {reviewing && <span className="rp-muted">{w.emptyHint}</span>}
      {finished && <span className="rp-muted">{w.finishedWithoutChanges}</span>}
      <span className="rp-section-title">{w.finalMessage}</span>
      {reply.error ? (
        <ErrorText error={reply.error} />
      ) : reply.text === null ? (
        <span className="rp-muted">{t.common.loading}</span>
      ) : reply.text.trim() === "" ? (
        <span className="rp-muted">{w.noFinalMessage}</span>
      ) : (
        <pre className="rp-final-message" data-testid="final-message">
          {reply.text}
        </pre>
      )}
    </section>
  );
}

/** Review Gate 中 `manual` 條件的打勾（全部打勾後才能核准，§5.1）。 */
function ManualChecks({
  taskId,
  criteria,
  canCheck,
  skipped,
}: {
  taskId: string;
  criteria: readonly AcceptanceCriterion[];
  canCheck: boolean;
  skipped: boolean;
}) {
  const t = useT();
  const w = t.workspace.diff;
  const queryClient = useQueryClient();
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
  return (
    <section className="rp-diff-section" aria-labelledby="rp-manual-heading">
      <h3 id="rp-manual-heading" className="rp-section-title">
        {w.manualCriteria}
      </h3>
      {skipped && <p className="rp-notice">{w.skippedFailures}</p>}
      <ul className="rp-checks">
        {criteria
          .filter((c) => c.kind === "manual")
          .map((criterion) => (
            <li key={criterion.id} data-result={criterion.result}>
              <label className="rp-check">
                <input
                  type="checkbox"
                  checked={pending[criterion.id] ?? criterion.result === "passed"}
                  disabled={!canCheck || criterion.id in pending}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setPending((current) => ({ ...current, [criterion.id]: checked }));
                    check.mutate({ id: criterion.id, checked });
                  }}
                />
                {criterion.description}
              </label>
            </li>
          ))}
      </ul>
      <ErrorText error={check.error} />
    </section>
  );
}

/** 之前退回時的整體說明與行內留言；留言中的 @agent 建立的 consult Run 連結在這裡。 */
function PreviousReviews({ gates }: { gates: readonly Gate[] }) {
  const t = useT();
  const w = t.workspace.diff;
  const [open, setOpen] = useState(false);
  return (
    <section className="rp-diff-section" aria-labelledby="rp-previous-heading">
      <button
        id="rp-previous-heading"
        type="button"
        className="rp-row-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="rp-section-title">{w.previous}</span>
        <span className="rp-mono-muted">{gates.length}</span>
        <span className="st-chevron" data-open={open} aria-hidden="true">
          ›
        </span>
      </button>
      {open && (
        <ol className="rp-previous">
          {gates.map((gate) => (
            <li key={gate.id}>
              <span className="rp-mono-muted">
                {gate.decidedAt ? formatTime(gate.decidedAt) : ""}
              </span>
              {gate.comment && <MentionMarkdown text={gate.comment} />}
              {gate.reviewComments.map((comment) => (
                <div key={comment.id} className="rp-comment">
                  <span className="rp-muted">
                    <span className="rp-mono">{comment.path}</span>{" "}
                    {w.lineRef(comment.side === "new" ? w.newSide : w.oldSide, comment.line)}
                  </span>
                  <MentionMarkdown text={comment.body} />
                  <ConsultRunLinks runIds={comment.consultRunIds} />
                </div>
              ))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
