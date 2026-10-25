import {
  PERMISSION_POLICIES,
  type PermissionPolicy,
  type Project,
  type Repo,
  type UpdateProjectInput,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError } from "../../api/client";
import {
  createRepo,
  deleteRepo,
  projectQuery,
  queryKeys,
  refreshRepoInstallation,
  reposQuery,
  updateProject,
} from "../../api/resources";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/ErrorText";
import { TextField } from "../../components/TextField";
import { useT } from "../../i18n";
import { appInstallUrl } from "../../lib/github";
import { type PolicyFormValues, policyFormValues, validatePolicyForm } from "../../lib/policy-form";
import { type RepoFormValues, validateRepoForm } from "../../lib/project-forms";
import { usePermissions } from "../auth/use-permissions";
import { RepoSpecsSection } from "../repo-spec/RepoSpecsSection";

/**
 * Project 設定頁（最小版）：基本資料、Repo 列表與登記、政策。
 * 成員、Role 覆寫、Team Runner 與其他政策的修改在管理頁（C2）。
 */
export function ProjectSettingsPage({ projectId }: { projectId: string }) {
  const t = useT();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const permissions = usePermissions(project);

  return (
    <main className="settings-page">
      <nav className="breadcrumb">
        <Link to="/board" search={{ project: project.id }}>
          {project.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <span>{t.project.settings}</span>
      </nav>
      <header className="page-header">
        <h1>{t.project.title}</h1>
      </header>
      <div className="settings-layout">
        <BasicInfoSection
          key={project.updatedAt}
          project={project}
          canEdit={permissions.can("project.manage")}
        />
        <ReposSection project={project} canRegister={permissions.can("project.manage")} />
        <RepoSpecsSection projectId={project.id} canEdit={permissions.can("task.edit")} />
        <PolicySection
          project={project}
          canEditPermissionPolicy={permissions.can("policy.manage")}
          canEditPolicies={permissions.can("project.manage")}
        />
      </div>
    </main>
  );
}

/** 修改 Project 並更新快取：設定頁、看板的 Project 清單、派工對話框的預設政策。 */
function useUpdateProject(project: Project) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProjectInput) => updateProject(project.id, input),
    onSuccess: async (updated) => {
      queryClient.setQueryData(queryKeys.project(project.id), updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projects, exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dispatchOptions(project.id) }),
      ]);
    },
  });
}

function BasicInfoSection({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const t = useT();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const update = useUpdateProject(project);
  const changed = name.trim() !== project.name || description !== project.description;

  return (
    <section className="section" aria-labelledby="settings-basic">
      <h2 id="settings-basic">{t.project.basicInfo}</h2>
      {canEdit ? (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate({ name: name.trim(), description });
          }}
        >
          <TextField
            label={t.project.name}
            value={name}
            onChange={setName}
            error={name.trim() === "" ? t.project.nameRequired : undefined}
          />
          <TextField
            label={t.project.description}
            value={description}
            onChange={setDescription}
            multiline
          />
          <p>
            <span>{t.project.keyPrefix}</span> <code>{project.keyPrefix}</code>{" "}
            <span className="hint">{t.project.keyPrefixLocked}</span>
          </p>
          <ErrorText error={update.error} />
          <Button
            type="submit"
            variant="primary"
            disabled={!changed || name.trim() === "" || update.isPending}
          >
            {t.common.save}
          </Button>
        </form>
      ) : (
        <dl className="settings-list">
          <dt>{t.project.name}</dt>
          <dd>{project.name}</dd>
          <dt>{t.project.description}</dt>
          <dd>{project.description || <span className="hint">{t.project.noDescription}</span>}</dd>
          <dt>{t.project.keyPrefix}</dt>
          <dd>
            <code>{project.keyPrefix}</code>
          </dd>
        </dl>
      )}
    </section>
  );
}

function ReposSection({ project, canRegister }: { project: Project; canRegister: boolean }) {
  const t = useT();
  const { data: repos, error } = useQuery(reposQuery(project.id));

  return (
    <section className="section" aria-labelledby="settings-repos">
      <h2 id="settings-repos">{t.project.repos}</h2>
      <ErrorText error={error} />
      {repos?.length === 0 && <p className="empty">{t.project.noRepos}</p>}
      {repos && repos.length > 0 && (
        <table className="run-table repo-table">
          <thead>
            <tr>
              <th scope="col">{t.project.repoColumn}</th>
              <th scope="col">{t.project.defaultBranchColumn}</th>
              <th scope="col">{t.project.githubAppColumn}</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => (
              <tr key={repo.id} data-repo={`${repo.owner}/${repo.name}`}>
                <td>{repo.owner ? `${repo.owner}/${repo.name}` : repo.name}</td>
                <td>
                  <code>{repo.defaultBranch}</code>
                </td>
                <td data-installed={String(repo.github?.installed ?? false)}>
                  <RepoInstallation repo={repo} canManage={canRegister} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canRegister && <RegisterRepoForm project={project} />}
    </section>
  );
}

/**
 * GitHub App 的安裝狀態。App 在登記 Repo 之後才安裝、Server 又沒收到 installation webhook 時，
 * 可以手動重新檢查（#56）；GitHub 上同名 repo 的 id 與登記時不同（409 `repo_mismatch`）時，
 * 只能刪除後重新登記。
 */
function RepoInstallation({ repo, canManage }: { repo: Repo; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const installUrl = appInstallUrl(repo);
  const refresh = useMutation({
    mutationFn: () => refreshRepoInstallation(repo.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.repos(repo.projectId), (current: Repo[] | undefined) =>
        current?.map((r) => (r.id === updated.id ? updated : r)),
      );
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteRepo(repo.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.repos(repo.projectId) }),
  });
  const mismatch = refresh.error instanceof ApiError && refresh.error.code === "repo_mismatch";

  // TODO(backend, local-repo)：本機 Repo 沒有 GitHub App，改顯示「連接到 GitHub」。
  if (!repo.github) return null;
  if (repo.github.installed) return <>{t.project.installed}</>;
  return (
    <div className="repo-installation">
      {t.project.notInstalled}
      {installUrl ? (
        <>
          {" "}
          <a href={installUrl} target="_blank" rel="noreferrer">
            {t.project.installApp}
          </a>
        </>
      ) : (
        <span className="hint"> {t.project.appNotConfigured}</span>
      )}
      {/* 重新檢查與登記 Repo 相同：Admin 以上（Server 的 manage_project） */}
      {canManage && (
        <button
          type="button"
          className="link-button"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending ? t.project.checking : t.project.refreshInstallation}
        </button>
      )}
      {refresh.isSuccess && refresh.data.github?.installed === false && (
        <p className="hint" role="status">
          {t.project.stillNotInstalled}
        </p>
      )}
      {mismatch ? (
        <div className="notice-inline" role="alert">
          {t.project.repoMismatch(`${repo.owner}/${repo.name}`)}
          {canManage && (
            <Button
              variant="danger-ghost"
              disabled={remove.isPending}
              onClick={() => (confirmDelete ? remove.mutate() : setConfirmDelete(true))}
            >
              {confirmDelete ? t.project.confirmDeleteRepo : t.project.deleteRepo}
            </Button>
          )}
          <ErrorText error={remove.error} />
        </div>
      ) : (
        <ErrorText error={refresh.error} />
      )}
    </div>
  );
}

const EMPTY_REPO_FORM: RepoFormValues = { owner: "", name: "", defaultBranch: "" };

function RegisterRepoForm({ project }: { project: Project }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [values, setValues] = useState(EMPTY_REPO_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof RepoFormValues, string>>>({});
  const set = (field: keyof RepoFormValues) => (value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof createRepo>[1]) => createRepo(project.id, input),
    onSuccess: async () => {
      setValues(EMPTY_REPO_FORM);
      await queryClient.invalidateQueries({ queryKey: queryKeys.repos(project.id) });
    },
  });

  return (
    <form
      className="settings-form"
      aria-labelledby="settings-register-repo"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const result = validateRepoForm(values);
        setErrors(result.ok ? {} : result.errors);
        if (result.ok) mutation.mutate(result.input);
      }}
    >
      <h3 id="settings-register-repo">{t.project.registerRepo}</h3>
      <div className="repo-form-fields">
        <TextField
          label={t.project.owner}
          value={values.owner}
          onChange={set("owner")}
          error={errors.owner}
          placeholder={t.project.ownerPlaceholder}
        />
        <TextField
          label={t.project.repoName}
          value={values.name}
          onChange={set("name")}
          error={errors.name}
        />
        <TextField
          label={t.project.defaultBranch}
          value={values.defaultBranch}
          onChange={set("defaultBranch")}
          error={errors.defaultBranch}
          hint={t.project.defaultBranchHint}
        />
      </div>
      <ErrorText error={mutation.error} />
      <Button type="submit" variant="primary" disabled={mutation.isPending}>
        {t.project.register}
      </Button>
    </form>
  );
}

function PolicySection({
  project,
  canEditPermissionPolicy,
  canEditPolicies,
}: {
  project: Project;
  canEditPermissionPolicy: boolean;
  canEditPolicies: boolean;
}) {
  const t = useT();
  const { policy } = project;
  const yesNo = (value: boolean) => (value ? t.project.yes : t.project.no);

  return (
    <section className="section" aria-labelledby="settings-policy">
      <h2 id="settings-policy">{t.project.policy}</h2>
      {canEditPermissionPolicy ? (
        <PermissionPolicyForm key={policy.defaultPermissionPolicy} project={project} />
      ) : (
        <dl className="settings-list">
          <dt>{t.project.defaultPermissionPolicy}</dt>
          <dd data-testid="default-permission-policy">
            {t.labels.permissionPolicy[policy.defaultPermissionPolicy]}
          </dd>
        </dl>
      )}
      {canEditPolicies ? (
        <OtherPoliciesForm key={project.updatedAt} project={project} />
      ) : (
        <dl className="settings-list" aria-label={t.project.otherPolicies}>
          <dt>{t.project.planGate}</dt>
          <dd>{policy.planGateEnabled ? t.project.on : t.project.off}</dd>
          <dt>{t.project.delegationEnabled}</dt>
          <dd>{yesNo(policy.delegationEnabled)}</dd>
          {policy.delegationEnabled && (
            <>
              <dt>{t.project.delegationAgents}</dt>
              <dd>{policy.delegationAgents?.join(t.common.listSeparator) ?? t.project.noLimit}</dd>
            </>
          )}
          <dt>{t.project.forbidSelfApproval}</dt>
          <dd>{yesNo(policy.forbidSelfApproval)}</dd>
          <dt>{t.project.memberCanDispatchToTeamRunner}</dt>
          <dd>{yesNo(policy.memberCanDispatchToTeamRunner)}</dd>
          <dt>{t.project.autoCreateIssues}</dt>
          <dd>{yesNo(policy.autoCreateIssues)}</dd>
          <dt>{t.project.verificationMaxRetries}</dt>
          <dd>{t.project.retries(policy.verificationMaxRetries)}</dd>
          <dt>{t.project.feedbackBots}</dt>
          <dd>
            {policy.feedbackBotAllowlist.join(t.common.listSeparator) || t.project.noFeedbackBots}
          </dd>
        </dl>
      )}
    </section>
  );
}

/** 預設 Permission Policy 以外的政策（Admin 以上，§12.2）。 */
function OtherPoliciesForm({ project }: { project: Project }) {
  const t = useT();
  const [values, setValues] = useState(() => policyFormValues(project.policy));
  const [errors, setErrors] = useState<Partial<Record<keyof PolicyFormValues, string>>>({});
  const update = useUpdateProject(project);
  const set = <K extends keyof PolicyFormValues>(field: K, value: PolicyFormValues[K]) =>
    setValues((current) => ({ ...current, [field]: value }));
  const checkbox = (field: BooleanPolicyField, label: string) => (
    <label className="field-inline">
      <input
        type="checkbox"
        checked={values[field]}
        onChange={(event) => set(field, event.target.checked)}
      />
      {label}
    </label>
  );

  return (
    <form
      className="settings-form"
      aria-label={t.project.otherPolicies}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const result = validatePolicyForm(values);
        setErrors(result.ok ? {} : result.errors);
        if (result.ok) update.mutate({ policy: result.policy });
      }}
    >
      {checkbox("planGateEnabled", t.project.requirePlanGate)}
      <TextField
        label={t.project.verificationMaxRetries}
        value={values.verificationMaxRetries}
        onChange={(value) => set("verificationMaxRetries", value)}
        error={errors.verificationMaxRetries}
        hint={t.project.verificationMaxRetriesHint}
      />
      {checkbox("delegationEnabled", t.project.delegationEnabled)}
      {values.delegationEnabled && (
        <TextField
          label={t.project.delegationAgents}
          value={values.delegationAgents}
          onChange={(value) => set("delegationAgents", value)}
          error={errors.delegationAgents}
          hint={t.project.delegationAgentsHint}
        />
      )}
      {checkbox("forbidSelfApproval", t.project.forbidSelfApproval)}
      {checkbox("memberCanDispatchToTeamRunner", t.project.memberCanDispatchToTeamRunner)}
      {checkbox("autoCreateIssues", t.project.autoCreateIssues)}
      <TextField
        label={t.project.feedbackBots}
        value={values.feedbackBotAllowlist}
        onChange={(value) => set("feedbackBotAllowlist", value)}
        error={errors.feedbackBotAllowlist}
        multiline
        hint={t.project.feedbackBotsHint}
      />
      <ErrorText error={update.error} />
      <Button type="submit" variant="primary" disabled={update.isPending}>
        {t.project.saveOtherPolicies}
      </Button>
    </form>
  );
}

type BooleanPolicyField = {
  [K in keyof PolicyFormValues]: PolicyFormValues[K] extends boolean ? K : never;
}[keyof PolicyFormValues];

function PermissionPolicyForm({ project }: { project: Project }) {
  const t = useT();
  const current = project.policy.defaultPermissionPolicy;
  const [value, setValue] = useState<PermissionPolicy>(current);
  const update = useUpdateProject(project);

  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate({ policy: { defaultPermissionPolicy: value } });
      }}
    >
      <label className="field">
        {t.project.defaultPermissionPolicy}
        <select
          value={value}
          onChange={(event) => setValue(event.target.value as PermissionPolicy)}
        >
          {PERMISSION_POLICIES.map((p) => (
            <option key={p} value={p}>
              {t.labels.permissionPolicy[p]}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">{t.project.permissionPolicyHint}</p>
      <ErrorText error={update.error} />
      <Button type="submit" variant="primary" disabled={value === current || update.isPending}>
        {t.project.savePolicy}
      </Button>
    </form>
  );
}
