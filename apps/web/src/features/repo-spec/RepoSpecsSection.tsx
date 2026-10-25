import { CreateRepoSpecInput, type Repo } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { createRepoSpec, queryKeys, repoSpecsQuery, reposQuery } from "../../api/resources";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/ErrorText";
import { TextField } from "../../components/TextField";
import { useT } from "../../i18n";
import { repoDisplayName } from "../../lib/github";

/** Project 設定頁：每個 Repo 的 Spec 清單與登記（ARCHITECTURE §12.1）。 */
export function RepoSpecsSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const t = useT();
  const { data: repos = [] } = useQuery(reposQuery(projectId));
  if (repos.length === 0) return null;
  return (
    <section className="section" aria-labelledby="settings-specs">
      <h2 id="settings-specs">{t.repoSpec.section}</h2>
      <p className="hint">{t.repoSpec.sectionHint}</p>
      {repos.map((repo) => (
        <RepoSpecs key={repo.id} repo={repo} canEdit={canEdit} />
      ))}
    </section>
  );
}

function RepoSpecs({ repo, canEdit }: { repo: Repo; canEdit: boolean }) {
  const t = useT();
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
  const name = repoDisplayName(repo);

  return (
    <div className="repo-specs" data-repo={name}>
      <h3>{name}</h3>
      <ErrorText error={error} />
      {specs.length === 0 ? (
        <p className="empty">{t.repoSpec.noSpecs}</p>
      ) : (
        <ul>
          {specs.map((spec) => (
            <li key={spec.id}>
              <Link to="/repo-specs/$repoSpecId" params={{ repoSpecId: spec.id }}>
                {spec.title ?? spec.path}
              </Link>{" "}
              <code>{spec.path}</code>{" "}
              <span className="hint">{t.repoSpec.version(spec.version)}</span>
              {spec.openPullRequest && (
                <span className="tag">
                  {t.repoSpec.openPullRequest(spec.openPullRequest.number)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          className="settings-form repo-spec-form"
          aria-label={t.repoSpec.registerForm(name)}
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
            label={t.repoSpec.path}
            value={path}
            onChange={setPath}
            error={pathError}
            placeholder="docs/specs/login.md"
            hint={t.repoSpec.pathHint}
          />
          <TextField label={t.repoSpec.titleOptional} value={title} onChange={setTitle} />
          <ErrorText error={create.error} />
          <Button type="submit" disabled={create.isPending}>
            {t.repoSpec.register}
          </Button>
        </form>
      )}
    </div>
  );
}
