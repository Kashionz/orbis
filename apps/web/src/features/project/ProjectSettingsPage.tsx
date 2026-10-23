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
import { ErrorText } from "../../components/ErrorText";
import { TextField } from "../../components/TextField";
import { appInstallUrl } from "../../lib/github";
import { PERMISSION_POLICY_LABELS } from "../../lib/labels";
import { type PolicyFormValues, policyFormValues, validatePolicyForm } from "../../lib/policy-form";
import { type RepoFormValues, validateRepoForm } from "../../lib/project-forms";
import { usePermissions } from "../auth/use-permissions";
import { RepoSpecsSection } from "../repo-spec/RepoSpecsSection";

/**
 * Project 設定頁（最小版）：基本資料、Repo 列表與登記、政策。
 * 成員、Role 覆寫、Team Runner 與其他政策的修改在管理頁（C2）。
 */
export function ProjectSettingsPage({ projectId }: { projectId: string }) {
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const permissions = usePermissions(project);

  return (
    <main className="settings-page">
      <nav className="breadcrumb">
        <Link to="/board" search={{ project: project.id }}>
          {project.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <span>設定</span>
      </nav>
      <header className="page-header">
        <h1>Project 設定</h1>
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
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const update = useUpdateProject(project);
  const changed = name.trim() !== project.name || description !== project.description;

  return (
    <section className="section" aria-labelledby="settings-basic">
      <h2 id="settings-basic">基本資料</h2>
      {canEdit ? (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate({ name: name.trim(), description });
          }}
        >
          <TextField
            label="名稱"
            value={name}
            onChange={setName}
            error={name.trim() === "" ? "名稱不能是空白" : undefined}
          />
          <TextField label="描述" value={description} onChange={setDescription} multiline />
          <p>
            Task Key 前綴：<code>{project.keyPrefix}</code>
            <span className="hint">（建立後不能修改）</span>
          </p>
          <ErrorText error={update.error} />
          <button
            type="submit"
            className="primary"
            disabled={!changed || name.trim() === "" || update.isPending}
          >
            儲存
          </button>
        </form>
      ) : (
        <dl className="settings-list">
          <dt>名稱</dt>
          <dd>{project.name}</dd>
          <dt>描述</dt>
          <dd>{project.description || <span className="hint">沒有描述</span>}</dd>
          <dt>Task Key 前綴</dt>
          <dd>
            <code>{project.keyPrefix}</code>
          </dd>
        </dl>
      )}
    </section>
  );
}

function ReposSection({ project, canRegister }: { project: Project; canRegister: boolean }) {
  const { data: repos, error } = useQuery(reposQuery(project.id));

  return (
    <section className="section" aria-labelledby="settings-repos">
      <h2 id="settings-repos">Repo</h2>
      <ErrorText error={error} />
      {repos?.length === 0 && <p className="empty">還沒有登記任何 Repo。</p>}
      {repos && repos.length > 0 && (
        <table className="run-table repo-table">
          <thead>
            <tr>
              <th scope="col">Repo</th>
              <th scope="col">Default branch</th>
              <th scope="col">GitHub App</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => (
              <tr key={repo.id} data-repo={`${repo.owner}/${repo.name}`}>
                <td>
                  {repo.owner}/{repo.name}
                </td>
                <td>
                  <code>{repo.defaultBranch}</code>
                </td>
                <td data-installed={String(repo.github.installed)}>
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

  if (repo.github.installed) return <>已安裝</>;
  return (
    <div className="repo-installation">
      未安裝
      {installUrl ? (
        <>
          {" "}
          <a href={installUrl} target="_blank" rel="noreferrer">
            安裝 GitHub App
          </a>
        </>
      ) : (
        <span className="hint">（Server 沒有設定 GitHub App）</span>
      )}
      {/* 重新檢查與登記 Repo 相同：Admin 以上（Server 的 manage_project） */}
      {canManage && (
        <button
          type="button"
          className="link-button"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending ? "檢查中…" : "重新檢查 App 安裝狀態"}
        </button>
      )}
      {refresh.isSuccess && !refresh.data.github.installed && (
        <p className="hint" role="status">
          GitHub 上仍然沒有安裝。安裝完成後再按一次。
        </p>
      )}
      {mismatch ? (
        <div className="notice-inline" role="alert">
          GitHub 上的 {repo.owner}/{repo.name} 與登記時不是同一個 repo（可能被刪除後重建或改名）。
          請刪除這個 Repo 後重新登記。
          {canManage && (
            <button
              type="button"
              className="danger"
              disabled={remove.isPending}
              onClick={() => (confirmDelete ? remove.mutate() : setConfirmDelete(true))}
            >
              {confirmDelete ? "確定刪除這個 Repo" : "刪除這個 Repo"}
            </button>
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
      <h3 id="settings-register-repo">登記 Repo</h3>
      <div className="repo-form-fields">
        <TextField
          label="Owner"
          value={values.owner}
          onChange={set("owner")}
          error={errors.owner}
          placeholder="GitHub 使用者或組織"
        />
        <TextField
          label="Repo 名稱"
          value={values.name}
          onChange={set("name")}
          error={errors.name}
        />
        <TextField
          label="Default branch"
          value={values.defaultBranch}
          onChange={set("defaultBranch")}
          error={errors.defaultBranch}
          hint="可以不填：GitHub App 已安裝時用 GitHub 上的設定，否則用 main。"
        />
      </div>
      <ErrorText error={mutation.error} />
      <button type="submit" className="primary" disabled={mutation.isPending}>
        登記
      </button>
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
  const { policy } = project;
  const yesNo = (value: boolean) => (value ? "是" : "否");

  return (
    <section className="section" aria-labelledby="settings-policy">
      <h2 id="settings-policy">政策</h2>
      {canEditPermissionPolicy ? (
        <PermissionPolicyForm key={policy.defaultPermissionPolicy} project={project} />
      ) : (
        <dl className="settings-list">
          <dt>預設 Permission Policy</dt>
          <dd data-testid="default-permission-policy">
            {PERMISSION_POLICY_LABELS[policy.defaultPermissionPolicy]}
          </dd>
        </dl>
      )}
      {canEditPolicies ? (
        <OtherPoliciesForm key={project.updatedAt} project={project} />
      ) : (
        <dl className="settings-list" aria-label="其他政策">
          <dt>Plan Gate</dt>
          <dd>{policy.planGateEnabled ? "開啟" : "關閉"}</dd>
          <dt>允許 Delegation</dt>
          <dd>{yesNo(policy.delegationEnabled)}</dd>
          {policy.delegationEnabled && (
            <>
              <dt>可以分派的 Agent</dt>
              <dd>{policy.delegationAgents?.join("、") ?? "不限制"}</dd>
            </>
          )}
          <dt>禁止 Member 核准自己的 Task</dt>
          <dd>{yesNo(policy.forbidSelfApproval)}</dd>
          <dt>Member 可以派工到 Team Runner</dt>
          <dd>{yesNo(policy.memberCanDispatchToTeamRunner)}</dd>
          <dt>自動建立 GitHub Issue</dt>
          <dd>{yesNo(policy.autoCreateIssues)}</dd>
          <dt>Verification 自動重試上限</dt>
          <dd>{policy.verificationMaxRetries} 次</dd>
          <dt>會觸發 Feedback Loop 的 bot</dt>
          <dd>{policy.feedbackBotAllowlist.join("、") || "（沒有）"}</dd>
        </dl>
      )}
    </section>
  );
}

/** 預設 Permission Policy 以外的政策（Admin 以上，§12.2）。 */
function OtherPoliciesForm({ project }: { project: Project }) {
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
      aria-label="其他政策"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const result = validatePolicyForm(values);
        setErrors(result.ok ? {} : result.errors);
        if (result.ok) update.mutate({ policy: result.policy });
      }}
    >
      {checkbox("planGateEnabled", "需要 Plan Gate（Task 可以個別覆寫）")}
      <TextField
        label="Verification 自動重試上限"
        value={values.verificationMaxRetries}
        onChange={(value) => set("verificationMaxRetries", value)}
        error={errors.verificationMaxRetries}
        hint="第一輪之後最多自動重試幾次（1–10），超過就停下來等人決定。"
      />
      {checkbox("delegationEnabled", "允許 Delegation")}
      {values.delegationEnabled && (
        <TextField
          label="可以分派的 Agent"
          value={values.delegationAgents}
          onChange={(value) => set("delegationAgents", value)}
          error={errors.delegationAgents}
          hint="以逗號分隔，例如 claude-code, codex；留空表示不限制。"
        />
      )}
      {checkbox("forbidSelfApproval", "禁止 Member 核准自己的 Task")}
      {checkbox("memberCanDispatchToTeamRunner", "Member 可以派工到 Team Runner")}
      {checkbox("autoCreateIssues", "自動建立 GitHub Issue")}
      <TextField
        label="會觸發 Feedback Loop 的 bot"
        value={values.feedbackBotAllowlist}
        onChange={(value) => set("feedbackBotAllowlist", value)}
        error={errors.feedbackBotAllowlist}
        multiline
        hint="GitHub login，一行一個，例如 coderabbitai[bot]。其他 bot 的留言不觸發。"
      />
      <ErrorText error={update.error} />
      <button type="submit" className="primary" disabled={update.isPending}>
        儲存其他政策
      </button>
    </form>
  );
}

type BooleanPolicyField = {
  [K in keyof PolicyFormValues]: PolicyFormValues[K] extends boolean ? K : never;
}[keyof PolicyFormValues];

function PermissionPolicyForm({ project }: { project: Project }) {
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
        預設 Permission Policy
        <select
          value={value}
          onChange={(event) => setValue(event.target.value as PermissionPolicy)}
        >
          {PERMISSION_POLICIES.map((p) => (
            <option key={p} value={p}>
              {PERMISSION_POLICY_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">
        派工時的預設值，派工的人仍可以改。Team Runner 不提供 yolo，會改用 auto。
      </p>
      <ErrorText error={update.error} />
      <button type="submit" className="primary" disabled={value === current || update.isPending}>
        儲存政策
      </button>
    </form>
  );
}
