import { type Member, type Project, ROLES, type Role } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  addMember,
  deleteProjectRole,
  membersQuery,
  projectRolesQuery,
  queryKeys,
  removeMember,
  setProjectRole,
  updateMemberRole,
} from "../../api/resources";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/ErrorText";
import { TextField } from "../../components/TextField";
import { useT } from "../../i18n";

/** 只有 Owner 能指派或移除 Owner（§12.2）。 */
function assignableRoles(myRole: Role): readonly Role[] {
  return myRole === "owner" ? ROLES : ROLES.filter((r) => r !== "owner");
}

/**
 * 成員與 Role（ARCHITECTURE §12.2，Admin 以上）：以 GitHub login 新增、改 Role、移除。
 * 只有 Owner 能指派或移除 Owner；不能移除或降級最後一位 Owner（以 Server 的回應為準）。
 */
export function MembersSection({ myRole, myMemberId }: { myRole: Role; myMemberId: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: members = [], error } = useQuery(membersQuery);
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<Role>("member");
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.members });
  const add = useMutation({
    mutationFn: () => addMember({ githubLogin: login.trim(), role }),
    onSuccess: async () => {
      setLogin("");
      setRole("member");
      await refresh();
    },
  });

  return (
    <section className="section" aria-labelledby="admin-members">
      <h2 id="admin-members">{t.admin.members}</h2>
      <ErrorText error={error} />
      <table className="run-table member-table">
        <thead>
          <tr>
            <th scope="col">{t.admin.memberColumns.member}</th>
            <th scope="col">{t.admin.memberColumns.role}</th>
            <th scope="col">
              <span className="visually-hidden">{t.admin.memberColumns.actions}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              myRole={myRole}
              isMe={member.id === myMemberId}
              onChanged={refresh}
            />
          ))}
        </tbody>
      </table>
      <form
        className="settings-form inline-form"
        aria-label={t.admin.addMember}
        onSubmit={(event) => {
          event.preventDefault();
          if (login.trim() !== "") add.mutate();
        }}
      >
        <TextField label={t.admin.githubLogin} value={login} onChange={setLogin} />
        <label className="field">
          {t.admin.role}
          <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
            {assignableRoles(myRole).map((r) => (
              <option key={r} value={r}>
                {t.labels.role[r]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="primary" disabled={add.isPending || login.trim() === ""}>
          {t.admin.addMember}
        </Button>
        <ErrorText error={add.error} />
      </form>
    </section>
  );
}

function MemberRow({
  member,
  myRole,
  isMe,
  onChanged,
}: {
  member: Member;
  myRole: Role;
  isMe: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const update = useMutation({
    mutationFn: (role: Role) => updateMemberRole(member.id, role),
    onSuccess: onChanged,
  });
  const remove = useMutation({ mutationFn: () => removeMember(member.id), onSuccess: onChanged });
  // Admin 不能改動 Owner
  const editable = myRole === "owner" || member.role !== "owner";
  const label = `@${member.githubLogin}`;

  return (
    <tr data-member={member.githubLogin}>
      <td>
        {label}
        {member.name && <span className="hint"> {member.name}</span>}
        {isMe && <span className="tag">{t.admin.self}</span>}
      </td>
      <td>
        {editable ? (
          <select
            aria-label={t.admin.roleOf(label)}
            value={member.role}
            disabled={update.isPending}
            onChange={(event) => update.mutate(event.target.value as Role)}
          >
            {assignableRoles(myRole).map((r) => (
              <option key={r} value={r}>
                {t.labels.role[r]}
              </option>
            ))}
          </select>
        ) : (
          t.labels.role[member.role]
        )}
        <ErrorText error={update.error} />
      </td>
      <td>
        {editable && (
          <Button
            variant="danger-ghost"
            disabled={remove.isPending}
            onClick={() => (confirming ? remove.mutate() : setConfirming(true))}
          >
            {confirming ? t.admin.confirmRemove(label) : t.admin.remove}
          </Button>
        )}
        <ErrorText error={remove.error} />
      </td>
    </tr>
  );
}

const OVERRIDE_ROLES = ROLES.filter((r) => r !== "owner");

/** Project 的 Role 覆寫（Admin 以上）：不能覆寫成 Owner，Team 的 Owner 也不能被覆寫。 */
export function ProjectRolesSection({ projects }: { projects: readonly Project[] }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const { data: members = [] } = useQuery(membersQuery);
  const { data: overrides = [], error } = useQuery({
    ...projectRolesQuery(projectId),
    enabled: projectId !== "",
  });
  const [memberId, setMemberId] = useState("");
  const [role, setRole] = useState<(typeof OVERRIDE_ROLES)[number]>("viewer");
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.projectRoles(projectId) });
  const set = useMutation({
    mutationFn: ({ id, value }: { id: string; value: (typeof OVERRIDE_ROLES)[number] }) =>
      setProjectRole(projectId, id, value),
    onSuccess: async () => {
      setMemberId("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteProjectRole(projectId, id),
    onSuccess: refresh,
  });
  const candidates = members.filter(
    (m) => m.role !== "owner" && !overrides.some((o) => o.memberId === m.id),
  );
  const loginOf = (id: string) => members.find((m) => m.id === id)?.githubLogin ?? id;

  return (
    <section className="section" aria-labelledby="admin-project-roles">
      <h2 id="admin-project-roles">{t.admin.projectRoles}</h2>
      <label className="field-inline">
        {t.admin.project}
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {t.admin.projectOption(p.name, p.keyPrefix)}
            </option>
          ))}
        </select>
      </label>
      <ErrorText error={error ?? set.error ?? remove.error} />
      {overrides.length === 0 ? (
        <p className="empty">{t.admin.noOverrides}</p>
      ) : (
        <ul className="role-overrides" aria-label={t.admin.overridesList}>
          {overrides.map((o) => (
            <li key={o.memberId} data-member={loginOf(o.memberId)}>
              @{loginOf(o.memberId)}：
              <select
                aria-label={t.admin.roleInProject(`@${loginOf(o.memberId)}`)}
                value={o.role}
                onChange={(event) =>
                  set.mutate({
                    id: o.memberId,
                    value: event.target.value as (typeof OVERRIDE_ROLES)[number],
                  })
                }
              >
                {OVERRIDE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t.labels.role[r]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="link-button"
                disabled={remove.isPending}
                onClick={() => remove.mutate(o.memberId)}
              >
                {t.admin.clearOverride}
              </button>
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 0 && (
        <form
          className="settings-form inline-form"
          aria-label={t.admin.addOverride}
          onSubmit={(event) => {
            event.preventDefault();
            if (memberId !== "") set.mutate({ id: memberId, value: role });
          }}
        >
          <label className="field-inline">
            {t.admin.member}
            <select
              aria-label={t.admin.member}
              value={memberId}
              onChange={(event) => setMemberId(event.target.value)}
            >
              <option value="">{t.admin.chooseMember}</option>
              {candidates.map((m) => (
                <option key={m.id} value={m.id}>
                  {t.admin.memberWithTeamRole(`@${m.githubLogin}`, t.labels.role[m.role])}
                </option>
              ))}
            </select>
          </label>
          <label className="field-inline">
            {t.admin.overrideTo}
            <select
              aria-label={t.admin.overrideTo}
              value={role}
              onChange={(event) => setRole(event.target.value as (typeof OVERRIDE_ROLES)[number])}
            >
              {OVERRIDE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t.labels.role[r]}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={memberId === "" || set.isPending}>
            {t.admin.submitOverride}
          </Button>
        </form>
      )}
    </section>
  );
}
