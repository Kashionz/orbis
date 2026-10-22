import type { Project, Run, Task } from "@orbis/api-contract";
import type { TextBody } from "@orbis/protocol";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  cancelRun,
  decideReview,
  projectsQuery,
  queryKeys,
  reviewDiffQuery,
  runQuery,
  taskQuery,
} from "../../api/resources";
import type { ReviewComment, ReviewDiff, ReviewDiffFile } from "../../api/schemas";
import { ErrorText } from "../../components/ErrorText";
import { DIFF_CHANGE_LABELS } from "../../lib/labels";
import { usePermissions } from "../auth/use-permissions";
import { DiffEditor } from "./DiffEditor";
import { loadDraft, type ReviewDraft, saveDraft, sortComments } from "./review-drafts";

type Side = ReviewComment["side"];

/** Diff review（交付 6）：依檔案切換的 Monaco diff、行內留言、退回並附上留言、核准。 */
export function ReviewPage({ runId }: { runId: string }) {
  const { data: run } = useSuspenseQuery(runQuery(runId));
  const { data: diff } = useSuspenseQuery(reviewDiffQuery(runId));
  const { data: task } = useSuspenseQuery(taskQuery(run.taskId));
  const { data: projects } = useSuspenseQuery(projectsQuery);
  const project = projects.find((p) => p.id === task.projectId);
  if (!project) throw new Error("找不到 Task 所在的 Project");
  return <Review run={run} diff={diff} task={task} project={project} />;
}

function textOf(body: TextBody | null): string | null {
  if (body === null) return "";
  // TODO(api): blob 的內容要從 blob 端點取得；端點確定前先不顯示
  return body.type === "inline" ? body.text : null;
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
}: {
  run: Run;
  diff: ReviewDiff;
  task: Task;
  project: Project;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const permissions = usePermissions(project, task);
  const [selectedPath, setSelectedPath] = useState(diff.files[0]?.path ?? null);
  const [draft, setDraftState] = useState<ReviewDraft>(() => loadDraft(run.id));
  const [target, setTarget] = useState<CommentTarget | null>(null);
  const [body, setBody] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const file = diff.files.find((f) => f.path === selectedPath) ?? null;
  const awaitingReview = run.status === "awaiting_gate";
  const canReject = awaitingReview && permissions.can("gate.reject");
  const canApprove = awaitingReview && permissions.can("gate.approve");
  const canComment = canReject;

  function setDraft(next: ReviewDraft) {
    setDraftState(next);
    saveDraft(run.id, next);
  }

  useEffect(() => {
    if (target) bodyRef.current?.focus();
  }, [target]);

  const decision = useMutation({
    mutationFn: (kind: "approved" | "rejected") =>
      decideReview(
        run.id,
        kind === "approved"
          ? { decision: "approved" }
          : {
              decision: "rejected",
              comment: draft.summary.trim() === "" ? null : draft.summary.trim(),
              comments: sortComments(draft.comments),
            },
      ),
    onSuccess: async () => {
      setDraft({ comments: [], summary: "" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.run(run.id) }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.needsYou }),
      ]);
      await navigate({ to: "/runs/$runId", params: { runId: run.id } });
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelRun(run.id),
    onSuccess: () => navigate({ to: "/runs/$runId", params: { runId: run.id } }),
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

  function removeComment(comment: ReviewComment) {
    setDraft({ ...draft, comments: draft.comments.filter((c) => c !== comment) });
  }

  const fileComments = file ? draft.comments.filter((c) => c.path === file.path) : [];
  const original = file ? textOf(file.old) : null;
  const modified = file ? textOf(file.new) : null;
  const canSendRejection = draft.comments.length > 0 || draft.summary.trim() !== "";

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
      {!awaitingReview && (
        <p className="notice-inline">這個 Run 目前沒有在等待 Review Gate，只能檢視。</p>
      )}

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
          {file && original !== null && modified !== null && (
            <DiffEditor
              path={file.path}
              original={original}
              modified={modified}
              comments={fileComments}
              onLineClick={(line, side) => {
                if (canComment) setTarget({ line, side });
              }}
            />
          )}
          {file && (original === null || modified === null) && (
            <p className="hint">這個檔案的內容較大，存在 blob 中，目前無法在 diff 中顯示。</p>
          )}

          {file && canComment && (
            <CommentForm
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
                  <p>{comment.body}</p>
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
                onClick={() => decision.mutate("rejected")}
              >
                退回並附上留言（{draft.comments.length}）
              </button>
            )}
            {canApprove && (
              <button
                type="button"
                className="primary"
                disabled={decision.isPending}
                onClick={() => decision.mutate("approved")}
              >
                核准並開 PR
              </button>
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
  return (
    <li>
      <button
        type="button"
        className="file-button"
        aria-current={selected ? "true" : undefined}
        data-change={file.change}
        onClick={onSelect}
      >
        <span className="tag">{DIFF_CHANGE_LABELS[file.change]}</span>
        <span className="file-path">{file.path}</span>
        {commentCount > 0 && <span className="count-badge">{commentCount}</span>}
      </button>
    </li>
  );
}

interface CommentFormProps {
  target: CommentTarget | null;
  body: string;
  bodyRef: RefObject<HTMLTextAreaElement | null>;
  onTargetChange: (target: CommentTarget | null) => void;
  onBodyChange: (body: string) => void;
  onSubmit: () => void;
}

/** 新增行內留言：點 diff 的行號，或直接輸入行號。 */
function CommentForm({
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
      <textarea
        ref={bodyRef}
        aria-label="留言內容"
        rows={3}
        placeholder={
          target
            ? `對${side === "new" ? "修改後" : "修改前"}第 ${target.line} 行留言`
            : "先選擇一行"
        }
        value={body}
        onChange={(event) => onBodyChange(event.target.value)}
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
