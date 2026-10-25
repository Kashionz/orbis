// 設定→帳號：頭像與名稱、團隊名稱（Admin 以上可以改）、成員、登出。

import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { membersQuery, teamQuery, updateTeam, updateTeamSettings } from "../../api/resources";
import { Avatar, AvatarStack } from "../../components/Avatar";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/ErrorText";
import { Switch } from "../../components/Switch";
import { useT } from "../../i18n";
import { meQueryOptions } from "../auth/api";
import { logout } from "../auth/logout";
import { usePermissions } from "../auth/use-permissions";
import { displayName } from "../shell/ProfileMenu";
import { SettingRow } from "./SettingsDialog";

const TEAM_NAME_MAX = 32;

export function AccountSection({ onLeave }: { onLeave: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const { data: members = [] } = useQuery(membersQuery);
  const permissions = usePermissions();
  const signOut = useMutation({
    mutationFn: () => logout(),
    onSuccess: async (loggedOut) => {
      if (!loggedOut) return;
      onLeave();
      queryClient.clear();
      await navigate({ to: "/login" });
    },
  });

  return (
    <>
      <div className="settings-account">
        <Avatar person={{ name: displayName(me), avatarUrl: me.avatarUrl }} size={48} />
        <div className="settings-account-text">
          <span className="settings-account-name">{displayName(me)}</span>
          {/* GitHub 帳號主要且已驗證的 email；沒有時顯示 GitHub login */}
          <span className="setting-sub">{me.member?.email ?? `@${me.githubLogin}`}</span>
        </div>
      </div>
      <TeamNameRow current={me.member?.teamName ?? ""} editable={permissions.can("team.manage")} />
      {permissions.can("team.manage") && <TeamSharingRows />}
      <SettingRow label={t.settings.members}>
        <span className="settings-members">
          <AvatarStack
            people={members.map((m) => ({ name: m.githubLogin, avatarUrl: m.avatarUrl }))}
            size={22}
            max={5}
          />
          <span className="setting-sub">{t.settings.memberCount(members.length)}</span>
          {me.member?.role !== "viewer" && (
            <Link to="/admin" className="settings-link" onClick={onLeave}>
              {t.settings.manageMembers}
            </Link>
          )}
        </span>
      </SettingRow>
      <div className="settings-signout">
        <Button
          variant="danger-ghost"
          icon={<LogOut size={14} />}
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          {t.shell.signOut}
        </Button>
        <ErrorText error={signOut.error} />
      </div>
    </>
  );
}

/** 團隊名稱：Enter 或離開欄位時儲存，Esc 還原。 */
/**
 * Team 的兩個分享設定（Admin 以上）：允許對外分享預覽（ADR-0015）、允許 Team Runner 的終端機（ADR-0014），
 * 預設都關閉。
 */
function TeamSharingRows() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: team } = useQuery(teamQuery);
  const save = useMutation({
    mutationFn: updateTeamSettings,
    onSuccess: (updated) => queryClient.setQueryData(teamQuery.queryKey, updated),
  });
  return (
    <>
      <SettingRow label={t.settings.allowExternalPreview} sub={t.settings.allowExternalPreviewSub}>
        <Switch
          label={t.settings.allowExternalPreview}
          checked={save.variables?.allowExternalPreview ?? team?.allowExternalPreview ?? false}
          disabled={!team || save.isPending}
          onChange={(value) => save.mutate({ allowExternalPreview: value })}
        />
      </SettingRow>
      <SettingRow
        label={t.settings.allowTeamRunnerTerminal}
        sub={t.settings.allowTeamRunnerTerminalSub}
      >
        <Switch
          label={t.settings.allowTeamRunnerTerminal}
          checked={
            save.variables?.allowTeamRunnerTerminal ?? team?.allowTeamRunnerTerminal ?? false
          }
          disabled={!team || save.isPending}
          onChange={(value) => save.mutate({ allowTeamRunnerTerminal: value })}
        />
      </SettingRow>
      <ErrorText error={save.error} />
    </>
  );
}

function TeamNameRow({ current, editable }: { current: string; editable: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (name: string) => updateTeam(name),
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: meQueryOptions.queryKey });
    },
  });

  function commit() {
    const name = (draft ?? "").trim();
    if (draft === null || name === "" || name === current) {
      setDraft(null);
      return;
    }
    save.mutate(name);
  }

  return (
    <SettingRow label={t.settings.teamName}>
      <span className="settings-team">
        <input
          className="settings-input"
          value={draft ?? current}
          maxLength={TEAM_NAME_MAX}
          aria-label={t.settings.teamName}
          readOnly={!editable}
          disabled={save.isPending}
          data-own-escape={draft !== null ? "" : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape" && draft !== null) {
              event.preventDefault();
              setDraft(null);
            }
          }}
        />
        <ErrorText error={save.error} />
      </span>
    </SettingRow>
  );
}
