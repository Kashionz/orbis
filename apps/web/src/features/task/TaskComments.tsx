import type { Member, TaskComment } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  createTaskComment,
  deleteTaskComment,
  membersQuery,
  queryKeys,
  taskCommentsQuery,
  updateTaskComment,
} from "../../api/resources";
import { Avatar } from "../../components/Avatar";
import { ErrorText } from "../../components/ErrorText";
import { useT } from "../../i18n";
import { formatTime } from "../../lib/format";
import { MentionMarkdown } from "../mention/MentionMarkdown";
import { MentionTextarea } from "../mention/MentionTextarea";
import "./comments.css";

/**
 * Task 留言（ARCHITECTURE §12.3）：可以 @成員或 @agent；@agent 會建立 `consult` Run，
 * 留言下方顯示它的連結，Run 結束後 Agent 的回覆貼回成一則留言。
 */
export function TaskComments({
  taskId,
  projectId,
  memberId,
  canComment,
}: {
  taskId: string;
  projectId: string;
  /** 目前登入者；只能修改或刪除自己的留言。 */
  memberId: string;
  canComment: boolean;
}) {
  const t = useT();
  const c = t.workspace.comments;
  const queryClient = useQueryClient();
  const { data: comments = [], error } = useQuery(taskCommentsQuery(taskId));
  const { data: members = [] } = useQuery(membersQuery);
  const [body, setBody] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.taskComments(taskId) });
  const create = useMutation({
    mutationFn: () => createTaskComment(taskId, body.trim()),
    onSuccess: async () => {
      setBody("");
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: queryKeys.taskRuns(taskId) }),
      ]);
    },
  });

  return (
    <section className="tc" aria-labelledby="tc-heading">
      <h2 id="tc-heading" className="rp-section-title">
        {c.title}
      </h2>
      <ErrorText error={error} />
      {comments.length === 0 && <span className="rp-muted">{c.empty}</span>}
      <ol className="tc-thread">
        {comments.map((comment) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            members={members}
            projectId={projectId}
            own={comment.authorMemberId === memberId}
            onChanged={refresh}
          />
        ))}
      </ol>
      {canComment && (
        <form
          className="tc-form"
          aria-label={c.newComment}
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim() !== "") create.mutate();
          }}
        >
          <MentionTextarea
            projectId={projectId}
            label={c.body}
            value={body}
            onChange={setBody}
            placeholder={c.placeholder}
          />
          <ErrorText error={create.error} />
          <div className="tc-actions">
            <button
              type="submit"
              className="o-btn"
              data-variant="primary"
              disabled={create.isPending || body.trim() === ""}
            >
              {c.send}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function CommentItem({
  comment,
  members,
  projectId,
  own,
  onChanged,
}: {
  comment: TaskComment;
  members: readonly Member[];
  projectId: string;
  own: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const t = useT();
  const c = t.workspace.comments;
  const [draft, setDraft] = useState<string | null>(null);
  const author = members.find((m) => m.id === comment.authorMemberId);
  const save = useMutation({
    mutationFn: (body: string) => updateTaskComment(comment.id, body),
    onSuccess: async () => {
      setDraft(null);
      await onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteTaskComment(comment.id),
    onSuccess: onChanged,
  });

  return (
    <li className="tc-item task-comment" data-comment-id={comment.id}>
      <div className="tc-meta">
        {comment.authorRunId ? (
          <>
            <span className="tc-author">{c.agentReply}</span>
            <Link to="/runs/$runId" params={{ runId: comment.authorRunId }} className="tc-link">
              {c.fromRun(comment.authorRunId)}
            </Link>
          </>
        ) : (
          <>
            <Avatar
              person={author ? { name: author.githubLogin, avatarUrl: author.avatarUrl } : null}
              size={18}
            />
            <span className="tc-author">{author ? `@${author.githubLogin}` : c.removedMember}</span>
          </>
        )}
        <span className="tc-time">{formatTime(comment.createdAt)}</span>
        {comment.updatedAt !== comment.createdAt && <span className="tc-time">{c.edited}</span>}
        {own && draft === null && (
          <span className="tc-own">
            <button type="button" className="rp-text-btn" onClick={() => setDraft(comment.body)}>
              {c.edit}
            </button>
            <button
              type="button"
              className="rp-text-btn"
              data-danger="true"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t.common.delete}
            </button>
          </span>
        )}
      </div>
      {draft === null ? (
        <div className="tc-body">
          <MentionMarkdown text={comment.body} />
        </div>
      ) : (
        <form
          className="tc-form"
          aria-label={c.editComment}
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim() !== "") save.mutate(draft.trim());
          }}
        >
          <MentionTextarea projectId={projectId} label={c.editComment} value={draft} onChange={setDraft} />
          <div className="tc-actions">
            <button type="button" className="o-btn" data-variant="ghost" onClick={() => setDraft(null)}>
              {t.common.cancel}
            </button>
            <button type="submit" className="o-btn" data-variant="primary" disabled={save.isPending}>
              {t.common.save}
            </button>
          </div>
        </form>
      )}
      <ConsultRunLinks runIds={comment.consultRunIds} />
      <ErrorText error={save.error ?? remove.error} />
    </li>
  );
}

/** @agent 建立的 consult Run 的連結（Task 留言、diff 行內留言共用）。 */
export function ConsultRunLinks({ runIds }: { runIds: readonly string[] }) {
  const t = useT();
  if (runIds.length === 0) return null;
  return (
    <p className="tc-consult">
      {runIds.map((runId) => (
        <Link key={runId} to="/runs/$runId" params={{ runId }} className="tc-link">
          {t.workspace.comments.consultRun(runId)}
        </Link>
      ))}
    </p>
  );
}
