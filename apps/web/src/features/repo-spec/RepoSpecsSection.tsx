import { CreateRepoSpecInput, type Repo } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { createRepoSpec, queryKeys, repoSpecsQuery, reposQuery } from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { TextField } from "../../components/TextField";

/** Project 設定頁：每個 Repo 的 Spec 清單與登記（ARCHITECTURE §12.1）。 */
export function RepoSpecsSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const { data: repos = [] } = useQuery(reposQuery(projectId));
  if (repos.length === 0) return null;
  return (
    <section className="section" aria-labelledby="settings-specs">
      <h2 id="settings-specs">Repo Spec</h2>
      <p className="hint">
        Repo 中的 markdown Spec，在 UI 中共同編輯草稿，按下「提交到 repo」後開 PR。
      </p>
      {repos.map((repo) => (
        <RepoSpecs key={repo.id} repo={repo} canEdit={canEdit} />
      ))}
    </section>
  );
}

function RepoSpecs({ repo, canEdit }: { repo: Repo; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { data: specs = [], error } = useQuery(repoSpecsQuery(repo.id));
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [pathError, setPathError] = useState<string | undefined>();
  const create = useMutation({
    mutationFn: (input: CreateRepoSpecInput) => createRepoSpec(repo.id, input),
    onSuccess: async () => {
      setPath("");
      setTitle("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.repoSpecs(repo.id) });
    },
  });
  const name = `${repo.owner}/${repo.name}`;

  return (
    <div className="repo-specs" data-repo={name}>
      <h3>{name}</h3>
      <ErrorText error={error} />
      {specs.length === 0 ? (
        <p className="empty">還沒有登記 Spec。</p>
      ) : (
        <ul>
          {specs.map((spec) => (
            <li key={spec.id}>
              <Link to="/repo-specs/$repoSpecId" params={{ repoSpecId: spec.id }}>
                {spec.title ?? spec.path}
              </Link>{" "}
              <code>{spec.path}</code> <span className="hint">第 {spec.version} 版</span>
              {spec.openPullRequest && (
                <span className="tag">PR #{spec.openPullRequest.number} 未合併</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          className="settings-form repo-spec-form"
          aria-label={`登記 ${name} 的 Spec`}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = CreateRepoSpecInput.safeParse({
              path: path.trim(),
              title: title.trim() === "" ? null : title.trim(),
            });
            if (!parsed.success) {
              setPathError(parsed.error.issues[0]?.message);
              return;
            }
            setPathError(undefined);
            create.mutate(parsed.data);
          }}
        >
          <TextField
            label="Spec 路徑"
            value={path}
            onChange={setPath}
            error={pathError}
            placeholder="docs/specs/login.md"
            hint="repo 內以 / 分隔的相對路徑，結尾是 .md；檔案還不存在時，提交後才建立。"
          />
          <TextField label="標題（選填）" value={title} onChange={setTitle} />
          <ErrorText error={create.error} />
          <button type="submit" disabled={create.isPending}>
            登記 Spec
          </button>
        </form>
      )}
    </div>
  );
}
