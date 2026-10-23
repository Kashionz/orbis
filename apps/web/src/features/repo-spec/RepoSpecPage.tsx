import type { RepoSpecCommitResponse } from "@orbis/api-contract";
import { useMutation, useQueries, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  commitRepoSpec,
  projectsQuery,
  queryKeys,
  repoSpecQuery,
  reposQuery,
} from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { usePermissions } from "../auth/use-permissions";
import { CollabEditor } from "../collab/CollabEditor";
import { safeHref } from "../run/TimelineItemView";

/**
 * Repo 內 Spec 的草稿（ARCHITECTURE §12.1）：在 UI 中共同編輯，按下「提交到 repo」後由 GitHub App
 * 開 PR（已經有開著的 Spec PR 時更新它）；PR merge 後版本加 1。
 */
export function RepoSpecPage({ repoSpecId }: { repoSpecId: string }) {
  const queryClient = useQueryClient();
  const { data: spec } = useSuspenseQuery(repoSpecQuery(repoSpecId));
  const { data: projects } = useSuspenseQuery(projectsQuery);
  // Repo Spec 只帶 repoId：從各 Project 的 Repo 找出它所在的 Project
  const repoLists = useQueries({ queries: projects.map((p) => reposQuery(p.id)) });
  const index = repoLists.findIndex((list) => list.data?.some((r) => r.id === spec.repoId));
  const project = projects[index] ?? null;
  const repo = repoLists[index]?.data?.find((r) => r.id === spec.repoId) ?? null;
  const permissions = usePermissions(project);
  const canEdit = project !== null && permissions.can("task.edit");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<RepoSpecCommitResponse | null>(null);
  const commit = useMutation({
    mutationFn: () =>
      commitRepoSpec(spec.id, message.trim() === "" ? {} : { message: message.trim() }),
    onSuccess: async (response) => {
      setResult(response);
      setMessage("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.repoSpec(spec.id) });
    },
  });
  const pr = result?.pullRequest ?? spec.openPullRequest;
  const prHref = pr ? safeHref(pr.url) : null;

  return (
    <main className="repo-spec-page">
      <nav className="breadcrumb">
        {project ? (
          <Link to="/projects/$projectId/settings" params={{ projectId: project.id }}>
            {project.name}
          </Link>
        ) : (
          <span>Project</span>
        )}
        <span aria-hidden="true"> / </span>
        <span>{repo ? `${repo.owner}/${repo.name}` : "Repo"}</span>
      </nav>
      <header className="page-header">
        <div>
          <h1>{spec.title ?? spec.path}</h1>
          <div className="hint">
            <code>{spec.path}</code>，第 {spec.version} 版
            {spec.committedSha && (
              <>
                ，<code>{spec.committedSha.slice(0, 7)}</code>
              </>
            )}
          </div>
        </div>
      </header>
      <p className="hint">
        這是 Spec 的草稿，所有人可以一起編輯；按下「提交到 repo」才會開 PR。Agent 要修改 Spec
        時會另外開 PR，不會直接覆蓋草稿。
      </p>
      {project && (
        <CollabEditor
          docRef={{ kind: "repo-spec-draft", id: spec.id }}
          label="Spec 草稿"
          canEdit={canEdit}
          projectId={project.id}
        />
      )}
      {pr && (
        <p className="spec-pr" role="status">
          {result ? (result.created ? "已開 PR：" : "已更新 PR：") : "開著的 Spec PR："}
          {prHref ? (
            <a href={prHref} target="_blank" rel="noreferrer">
              #{pr.number}
            </a>
          ) : (
            `#${pr.number}`
          )}
        </p>
      )}
      {result?.overwritesUpstreamChanges && (
        <p className="notice-inline" role="alert">
          default branch 上的 {spec.path} 在上次版本之後被修改過，這個 PR
          會覆蓋那些修改，合併前請確認。
        </p>
      )}
      {canEdit && (
        <form
          className="settings-form"
          aria-label="提交到 repo"
          onSubmit={(event) => {
            event.preventDefault();
            commit.mutate();
          }}
        >
          <label className="field">
            commit 訊息（選填）
            <input
              value={message}
              maxLength={200}
              placeholder={`docs: 更新 ${spec.path}`}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          <ErrorText error={commit.error} />
          <button type="submit" className="primary" disabled={commit.isPending}>
            提交到 repo
          </button>
        </form>
      )}
    </main>
  );
}
