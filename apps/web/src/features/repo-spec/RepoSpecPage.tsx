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
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/ErrorText";
import { useT } from "../../i18n";
import { repoDisplayName } from "../../lib/github";
import { usePermissions } from "../auth/use-permissions";
import { CollabEditor } from "../collab/CollabEditor";
import { safeHref } from "../run/stream/safe-href";

/**
 * Repo 內 Spec 的草稿（ARCHITECTURE §12.1）：在 UI 中共同編輯，按下「提交到 repo」後由 GitHub App
 * 開 PR（已經有開著的 Spec PR 時更新它）；PR merge 後版本加 1。
 */
export function RepoSpecPage({ repoSpecId }: { repoSpecId: string }) {
  const t = useT();
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
          <span>{t.repoSpec.projectFallback}</span>
        )}
        <span aria-hidden="true"> / </span>
        <span>{repo ? repoDisplayName(repo) : t.repoSpec.repoFallback}</span>
      </nav>
      <header className="page-header">
        <div>
          <h1>{spec.title ?? spec.path}</h1>
          <div className="hint">
            <code>{spec.path}</code> <span>{t.repoSpec.version(spec.version)}</span>
            {spec.committedSha && (
              <>
                {" "}
                <code>{spec.committedSha.slice(0, 7)}</code>
              </>
            )}
          </div>
        </div>
      </header>
      <p className="hint">{t.repoSpec.draftHint}</p>
      {project && (
        <CollabEditor
          docRef={{ kind: "repo-spec-draft", id: spec.id }}
          label={t.repoSpec.editorLabel}
          canEdit={canEdit}
          projectId={project.id}
        />
      )}
      {pr && (
        <p className="spec-pr" role="status">
          {result
            ? result.created
              ? t.repoSpec.prCreated
              : t.repoSpec.prUpdated
            : t.repoSpec.prOpen}
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
          {t.repoSpec.overwritesUpstream(spec.path)}
        </p>
      )}
      {canEdit && (
        <form
          className="settings-form"
          aria-label={t.repoSpec.commit}
          onSubmit={(event) => {
            event.preventDefault();
            commit.mutate();
          }}
        >
          <label className="field">
            {t.repoSpec.commitMessage}
            <input
              value={message}
              maxLength={200}
              placeholder={t.repoSpec.commitPlaceholder(spec.path)}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          <ErrorText error={commit.error} />
          <Button type="submit" variant="primary" disabled={commit.isPending}>
            {t.repoSpec.commit}
          </Button>
        </form>
      )}
    </main>
  );
}
