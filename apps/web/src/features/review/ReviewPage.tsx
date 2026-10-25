import type {
  Gate,
  Project,
  ReviewCommentInput,
  ReviewDiff,
  ReviewDiffFile,
  Run,
  Task,
  TextBody,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  acceptanceCriteriaQuery,
  blobTextQuery,
  blobUrl,
  cancelRun,
  decideGate,
  projectsQuery,
  queryKeys,
  reviewDiffQuery,
  runQuery,
  taskGatesQuery,
  taskQuery,
} from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { useT } from "../../i18n";
import { formatTime } from "../../lib/format";
import { usePermissions } from "../auth/use-permissions";
import { MentionMarkdown } from "../mention/MentionMarkdown";
import { MentionTextarea } from "../mention/MentionTextarea";
import {
  clearPreviewDrafts,
  loadPreviewDrafts,
  savePreviewDrafts,
  subscribePreviewDrafts,
} from "../preview/preview-drafts";
import { ConsultRunLinks } from "../task/TaskComments";
import { DiffEditor } from "./DiffEditor";
import { ReviewCriteria, uncheckedManualCriteria } from "./ReviewCriteria";
import { loadDraft, type ReviewDraft, saveDraft, sortComments } from "./review-drafts";

type Side = ReviewCommentInput["side"];

/**
 * Diff review（交付 6）：依檔案切換的 Monaco diff、行內留言、退回並附上留言、核准。
 * diff 為空時沒有東西可以 push：不能核准，改為「結束（沒有變更）」或退回，並顯示 Agent 最後的回覆（#73）。
 */
export function ReviewPage({ runId }: { runId: string }) {
  const { data: run } = useSuspenseQuery(runQuery(runId));
  const { data: diff } = useSuspenseQuery(reviewDiffQuery(runId));
  const { data: task } = useSuspenseQuery(taskQuery(run.taskId));
  const { data: gates } = useSuspenseQuery(taskGatesQuery(run.taskId));
  const { data: projects } = useSuspenseQuery(projectsQuery);
  const project = projects.find((p) => p.id === task.projectId);
  if (!project) throw new Error("找不到 Task 所在的 Project");
  // 這個 Run 還在等待決定的 Review Gate；沒有時只能檢視
  const gate =
    gates.find((g) => g.runId === run.id && g.kind === "review" && g.decision === null) ?? null;
  // 這個 Run 之前退回的 Review Gate（留言中 @agent 建立的 consult Run 顯示在這裡）
  const previous = gates.filter(
    (g) => g.runId === run.id && g.kind === "review" && g.decision === "rejected",
  );
  // 以「結束（沒有變更）」結束的 Review Gate
  const finished = gates.some((g) => g.runId === run.id && g.finishedWithoutChanges);
  return (
    <Review
      run={run}
      diff={diff}
      task={task}
      project={project}
      gate={gate}
      previous={previous}
      finished={finished}
    />
  );
}

/**
 * 檔案某一側的內容：內嵌的直接用，放在 blob 的向 Server 取得。
 * 不存在的一側（新增或刪除的檔案）為空字串；還在讀取或讀取失敗時 `text` 為 null。
 */
function useTextBody(body: TextBody | null): { text: string | null; error: unknown } {
  const blobId = body?.type === "blob" ? body.blob_id : null;
  const blob = useQuery({ ...blobTextQuery(blobId ?? ""), enabled: blobId !== null });
  if (body === null) return { text: "", error: null };
  if (body.type === "inline") return { text: body.text, error: null };
  return { text: blob.data ?? null, error: blob.error };
}

interface CommentTarget {
  line: number;
  side: Side;
}

function Review({
  run,
  diff,
  task,
  project,
  gate,
  previous,
  finished,
}: {
  run: Run;
  diff: ReviewDiff;
  task: Task;
  project: Project;
  gate: Gate | null;
  previous: readonly Gate[];
  finished: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const permissions = usePermissions(project, task);
  const [selectedPath, setSelectedPath] = useState(diff.files[0]?.path ?? null);
  const [draft, setDraftState] = useState<ReviewDraft>(() => loadDraft(run.id));
  // Preview 分頁寫的留言草稿（E 軌的 preview-drafts），退回時一起送出
  const [previewDrafts, setPreviewDrafts] = useState(() => loadPreviewDrafts(run.id));
  useEffect(
    () => subscribePreviewDrafts(run.id, () => setPreviewDrafts(loadPreviewDrafts(run.id))),
    [run.id],
  );
  const [target, setTarget] = useState<CommentTarget | null>(null);
  const [body, setBody] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const file = diff.files.find((f) => f.path === selectedPath) ?? null;
  const awaitingReview = gate !== null;
  // 沒有任何檔案變更：核准改為結束（沒有變更），Server 也以同一份 diff 判斷
  const empty = diff.files.length === 0;
  const canReject = awaitingReview && permissions.can("gate.reject");
  const canApprove = awaitingReview && permissions.can("gate.approve");
  const canComment = canReject;
  const { data: criteria = [] } = useQuery(acceptanceCriteriaQuery(task.id));
  const unchecked = uncheckedManualCriteria(criteria);

  function setDraft(next: ReviewDraft) {
    setDraftState(next);
    saveDraft(run.id, next);
  }

  useEffect(() => {
    if (target) bodyRef.current?.focus();
  }, [target]);

  async function afterDecision() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.run(run.id) }),
      queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.needsYou }),
    ]);
    await navigate({ to: "/runs/$runId", params: { runId: run.id } });
  }

  const decision = useMutation({
    mutationFn: async (action: "approve" | "finish_without_changes" | "reject") => {
      if (!gate) throw new Error("這個 Run 目前沒有在等待 Review Gate");
      await decideGate(
        gate.id,
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
      await afterDecision();
    },
  });
  // 在 Review Gate 中止：以 Gate 的 abort 決定送出（Task 回到 Ready）；沒有 Gate 時直接中止 Run
  const cancel = useMutation({
    mutationFn: async () => {
      if (gate) await decideGate(gate.id, { action: "abort" });
      else await cancelRun(run.id);
    },
    onSuccess: afterDecision,
  });

  function addComment() {
    if (!file || !target || body.trim() === "") return;
    setDraft({
      ...draft,
      comments: [
        ...draft.comments,
        { path: file.path, line: target.line, side: target.side, body: body.trim() },
      ],
    });
    setTarget(null);
    setBody("");
  }

  function removeComment(comment: ReviewCommentInput) {
    setDraft({ ...draft, comments: draft.comments.filter((c) => c !== comment) });
  }

  const fileComments = file ? draft.comments.filter((c) => c.path === file.path) : [];
  const original = useTextBody(file && !file.binary ? file.old : null);
  const modified = useTextBody(file && !file.binary ? file.new : null);
  const contentError = original.error ?? modified.error;
  const canSendRejection =
    draft.comments.length > 0 || previewDrafts.length > 0 || draft.summary.trim() !== "";

  return (
    <main className="review-page">
      <header className="page-header">
        <div>
          <nav className="breadcrumb">
            <Link to="/tasks/$taskKey" params={{ taskKey: task.key }}>
              {task.key} {task.title}
            </Link>
            <span aria-hidden="true"> / </span>
            <Link to="/runs/$runId" params={{ runId: run.id }}>
              Run {run.id}
            </Link>
          </nav>
          <h1>Diff review</h1>
          <div className="hint">
            base <code>{diff.baseCommit.slice(0, 7)}</code>，{diff.files.length} 個檔案，
            {draft.comments.length} 則留言
          </div>
        </div>
      </header>
      {!awaitingReview &&
        (finished ? (
          <p className="notice-inline">
            這個 Review Gate 已結束（沒有變更），Task 已轉為 Done，沒有 push 也沒有開 PR。
          </p>
        ) : (
          <p className="notice-inline">這個 Run 目前沒有在等待 Review Gate，只能檢視。</p>
        ))}
      {empty && <EmptyDiff awaitingReview={awaitingReview} finalMessage={diff.finalMessage} />}

      <div className="review-layout">
        <nav className="file-list" aria-label="變更的檔案">
          {diff.files.length === 0 && <p className="empty">沒有變更</p>}
          <ul>
            {diff.files.map((f) => (
              <FileButton
                key={f.path}
                file={f}
                selected={f.path === file?.path}
                commentCount={draft.comments.filter((c) => c.path === f.path).length}
                onSelect={() => {
                  setSelectedPath(f.path);
                  setTarget(null);
                }}
              />
            ))}
          </ul>
        </nav>

        <section className="review-main">
          {file && !file.binary && original.text !== null && modified.text !== null && (
            <DiffEditor
              path={file.path}
              original={original.text}
              modified={modified.text}
              comments={fileComments}
              onLineClick={(line, side) => {
                if (canComment) setTarget({ line, side });
              }}
            />
          )}
          {file?.binary && <p className="hint">二進位檔案，只顯示有變更，無法檢視內容。</p>}
          {file && !file.binary && contentError ? (
            <ErrorText error={contentError} />
          ) : (
            file &&
            !file.binary &&
            (original.text === null || modified.text === null) && (
              <p className="hint">正在讀取檔案內容…</p>
            )
          )}

          {file && !file.binary && canComment && (
            <CommentForm
              projectId={project.id}
              target={target}
              body={body}
              bodyRef={bodyRef}
              onTargetChange={setTarget}
              onBodyChange={setBody}
              onSubmit={addComment}
            />
          )}

          {fileComments.length > 0 && (
            <ul className="comment-list" aria-label="這個檔案的留言">
              {sortComments(fileComments).map((comment) => (
                <li
                  key={`${comment.side}-${comment.line}-${comment.body}`}
                  className="review-comment"
                >
                  <span className="hint">
                    {comment.side === "new" ? "修改後" : "修改前"}第 {comment.line} 行
                  </span>
                  <MentionMarkdown text={comment.body} />
                  {canComment && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => removeComment(comment)}
                    >
                      刪除留言
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {previewDrafts.length > 0 && (
        <section className="review-preview-drafts" aria-labelledby="preview-drafts-heading">
          <h2 id="preview-drafts-heading">Preview 留言（{previewDrafts.length}）</h2>
          <p className="hint">在 Run 頁的 Preview 分頁寫的留言，退回時和行內留言一起送給 Agent。</p>
          <ul className="comment-list">
            {previewDrafts.map((comment, index) => (
              <li
                key={comment.screenshotBlobId ?? `${comment.url}|${comment.body}`}
                className="review-comment"
              >
                <span className="hint">
                  {comment.url}
                  {comment.selector && (
                    <>
                      {" "}
                      <code>{comment.selector}</code>
                    </>
                  )}
                </span>
                <p>{comment.body}</p>
                {comment.screenshotBlobId && (
                  <img
                    className="preview-draft-shot"
                    src={blobUrl(comment.screenshotBlobId)}
                    alt="Preview 留言的截圖"
                  />
                )}
                {canComment && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      savePreviewDrafts(
                        run.id,
                        previewDrafts.filter((_, i) => i !== index),
                      )
                    }
                  >
                    刪除 Preview 留言
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <ReviewCriteria taskId={task.id} runId={run.id} canCheck={canApprove} />
      {previous.length > 0 && <PreviousReviews gates={previous} />}

      {(canReject || canApprove) && (
        <footer className="review-actions">
          {canReject && (
            <label className="field grow">
              整體說明（選填）
              <textarea
                rows={2}
                value={draft.summary}
                onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
              />
            </label>
          )}
          <ErrorText error={decision.error ?? cancel.error} />
          <div className="form-actions">
            {canReject && (
              <button
                type="button"
                className="danger"
                disabled={!canSendRejection || decision.isPending}
                onClick={() => decision.mutate("reject")}
              >
                退回並附上留言（{draft.comments.length + previewDrafts.length}）
              </button>
            )}
            {canApprove && (
              <button
                type="button"
                className="primary"
                disabled={decision.isPending || unchecked.length > 0}
                onClick={() => decision.mutate(empty ? "finish_without_changes" : "approve")}
              >
                {empty ? "結束（沒有變更）" : "核准並開 PR"}
              </button>
            )}
            {canApprove && unchecked.length > 0 && (
              <span className="hint" role="note">
                還有 {unchecked.length} 條 manual 條件沒有打勾，全部打勾後才能
                {empty ? "結束" : "核准"}
              </span>
            )}
            {permissions.can("run.control") && (
              <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                中止 Run
              </button>
            )}
          </div>
        </footer>
      )}
    </main>
  );
}

function FileButton({
  file,
  selected,
  commentCount,
  onSelect,
}: {
  file: ReviewDiffFile;
  selected: boolean;
  commentCount: number;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <li>
      <button
        type="button"
        className="file-button"
        aria-current={selected ? "true" : undefined}
        data-change={file.change}
        onClick={onSelect}
      >
        <span className="tag">{t.labels.diffChange[file.change]}</span>
        <span className="file-path">{file.path}</span>
        {commentCount > 0 && <span className="count-badge">{commentCount}</span>}
      </button>
    </li>
  );
}

/**
 * diff 為空時的說明與 Agent 最後的回覆（`final_message`）。人靠這段回覆判斷 Agent 是做完了、本來就不需要
 * 改檔（例如只回答問題），還是出了錯（例如模型錯誤被當成回覆），再決定結束（沒有變更）或退回。
 */
function EmptyDiff({
  awaitingReview,
  finalMessage,
}: {
  awaitingReview: boolean;
  finalMessage: TextBody | null;
}) {
  const reply = useTextBody(finalMessage);
  return (
    <section className="review-empty" aria-labelledby="empty-diff-heading">
      <h2 id="empty-diff-heading">這一版沒有任何檔案變更</h2>
      {awaitingReview && (
        <p className="hint" role="note">
          沒有東西可以 push，所以不能核准並開 PR。Task
          本來就不需要改檔（例如只是回答問題）時，選「結束（沒有變更）」，Task 會轉為 Done，不開
          PR；Agent 是因為錯誤而沒有做事時，看下方 Agent 的最後回覆，再退回或中止 Run。
        </p>
      )}
      <h3>Agent 的最後回覆</h3>
      {reply.error ? (
        <ErrorText error={reply.error} />
      ) : reply.text === null ? (
        <p className="hint">正在讀取…</p>
      ) : reply.text.trim() === "" ? (
        <p className="empty">Agent 沒有留下回覆</p>
      ) : (
        <pre className="final-message" data-testid="final-message">
          {reply.text}
        </pre>
      )}
    </section>
  );
}

/** 之前退回時的整體說明與行內留言；留言中的 @agent 建立的 consult Run 連結在這裡。 */
function PreviousReviews({ gates }: { gates: readonly Gate[] }) {
  return (
    <section className="previous-reviews" aria-labelledby="previous-reviews-heading">
      <h2 id="previous-reviews-heading">之前的退回</h2>
      <ol>
        {gates.map((gate) => (
          <li key={gate.id}>
            <span className="hint">{gate.decidedAt ? formatTime(gate.decidedAt) : ""}</span>
            {gate.comment && <MentionMarkdown text={gate.comment} />}
            <ul className="comment-list">
              {gate.reviewComments.map((comment) => (
                <li key={comment.id} className="review-comment">
                  <span className="hint">
                    <code>{comment.path}</code> {comment.side === "new" ? "修改後" : "修改前"}第{" "}
                    {comment.line} 行
                  </span>
                  <MentionMarkdown text={comment.body} />
                  <ConsultRunLinks runIds={comment.consultRunIds} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

interface CommentFormProps {
  projectId: string;
  target: CommentTarget | null;
  body: string;
  bodyRef: RefObject<HTMLTextAreaElement | null>;
  onTargetChange: (target: CommentTarget | null) => void;
  onBodyChange: (body: string) => void;
  onSubmit: () => void;
}

/** 新增行內留言：點 diff 的行號，或直接輸入行號。 */
function CommentForm({
  projectId,
  target,
  body,
  bodyRef,
  onTargetChange,
  onBodyChange,
  onSubmit,
}: CommentFormProps) {
  const side = target?.side ?? "new";
  return (
    <form
      className="comment-form"
      aria-label="新增行內留言"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="comment-target">
        <span>點擊 diff 的行號，或指定：</span>
        <select
          aria-label="留言在哪一側"
          value={side}
          onChange={(event) =>
            onTargetChange({ line: target?.line ?? 1, side: event.target.value as Side })
          }
        >
          <option value="new">修改後</option>
          <option value="old">修改前</option>
        </select>
        <label className="field-inline">
          第
          <input
            type="number"
            min={1}
            aria-label="行號"
            value={target?.line ?? ""}
            onChange={(event) => {
              const line = Number(event.target.value);
              onTargetChange(Number.isInteger(line) && line > 0 ? { line, side } : null);
            }}
          />
          行
        </label>
      </div>
      <MentionTextarea
        projectId={projectId}
        textareaRef={bodyRef}
        label="留言內容"
        rows={3}
        placeholder={
          target
            ? `對${side === "new" ? "修改後" : "修改前"}第 ${target.line} 行留言（可以 @ 提及）`
            : "先選擇一行"
        }
        value={body}
        onChange={onBodyChange}
      />
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!target || body.trim() === ""}>
          加入留言
        </button>
        {target && (
          <button type="button" onClick={() => onTargetChange(null)}>
            取消
          </button>
        )}
      </div>
    </form>
  );
}
