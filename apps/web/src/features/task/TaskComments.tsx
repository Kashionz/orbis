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
import { ErrorText } from "../../components/ErrorText";
import { formatTime } from "../../lib/format";
import { MentionMarkdown } from "../mention/MentionMarkdown";
import { MentionTextarea } from "../mention/MentionTextarea";

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
    <section className="section" aria-labelledby="comments-heading">
      <h2 id="comments-heading">留言</h2>
      <ErrorText error={error} />
      {comments.length === 0 && <p className="empty">還沒有留言</p>}
      <ol className="comment-thread">
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
          className="comment-form"
          aria-label="新增留言"
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim() !== "") create.mutate();
          }}
        >
          <MentionTextarea
            projectId={projectId}
            label="留言內容"
            value={body}
            onChange={setBody}
            placeholder="輸入 @ 提及成員或 Agent（@agent 會建立 consult Run）"
          />
          <ErrorText error={create.error} />
          <div className="form-actions">
            <button
              type="submit"
              className="primary"
              disabled={create.isPending || body.trim() === ""}
            >
              送出留言
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
    <li className="task-comment" data-comment-id={comment.id}>
      <div className="task-comment-meta">
        {comment.authorRunId ? (
          <>
            <strong>Agent 的回覆</strong>{" "}
            <Link to="/runs/$runId" params={{ runId: comment.authorRunId }}>
              來自 Run {comment.authorRunId}
            </Link>
          </>
        ) : (
          <strong>{author ? `@${author.githubLogin}` : "已移除的成員"}</strong>
        )}
        <span className="hint">{formatTime(comment.createdAt)}</span>
        {comment.updatedAt !== comment.createdAt && <span className="hint">（已編輯）</span>}
      </div>
      {draft === null ? (
        <MentionMarkdown text={comment.body} />
      ) : (
        <form
          aria-label="修改留言"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim() !== "") save.mutate(draft.trim());
          }}
        >
          <MentionTextarea
            projectId={projectId}
            label="修改留言"
            value={draft}
            onChange={setDraft}
          />
          <div className="form-actions">
            <button type="submit" className="primary" disabled={save.isPending}>
              儲存
            </button>
            <button type="button" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </form>
      )}
      <ConsultRunLinks runIds={comment.consultRunIds} />
      {own && draft === null && (
        <div className="form-actions">
          <button type="button" className="link-button" onClick={() => setDraft(comment.body)}>
            修改
          </button>
          <button
            type="button"
            className="link-button"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            刪除
          </button>
        </div>
      )}
      <ErrorText error={save.error ?? remove.error} />
    </li>
  );
}

/** @agent 建立的 consult Run 的連結（Task 留言、diff 行內留言共用）。 */
export function ConsultRunLinks({ runIds }: { runIds: readonly string[] }) {
  if (runIds.length === 0) return null;
  return (
    <p className="consult-runs">
      {runIds.map((runId) => (
        <Link key={runId} to="/runs/$runId" params={{ runId }}>
          @agent 的 consult Run（{runId}）
        </Link>
      ))}
    </p>
  );
}
