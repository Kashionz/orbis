// 側欄底部的個人按鈕與選單（README §1 Footer）：頭像（Local Runner 在線時綠點）、名稱、Runner 名稱；
// 選單有設定（Ctrl+,）、執行器、管理（Member 以上）、登出。

import type { MeResponse, Runner } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOut, Monitor, Settings, Shield } from "lucide-react";
import { type RefObject, useRef, useState } from "react";
import { runnersQuery } from "../../api/resources";
import { Avatar } from "../../components/Avatar";
import { ErrorText } from "../../components/ErrorText";
import { Floating } from "../../components/Floating";
import { FluidList, fluidItem } from "../../components/FluidList";
import { Kbd, shortcutLabel } from "../../components/Kbd";
import { StatusDot } from "../../components/StatusDot";
import { useT } from "../../i18n";
import { meQueryOptions } from "../auth/api";
import { logout } from "../auth/logout";
import { useShell } from "./shell-context";

/** 這位 Member 自己的 Local Runner（有多台時取在線、最近回報的那台）。 */
export function localRunnerOf(
  runners: readonly Runner[],
  memberId: string | undefined,
): Runner | null {
  const own = runners.filter((runner) => runner.kind === "local" && runner.memberId === memberId);
  own.sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      (b.lastHeartbeatAt ?? "").localeCompare(a.lastHeartbeatAt ?? ""),
  );
  return own[0] ?? null;
}

export function displayName(me: Pick<MeResponse, "name" | "githubLogin">): string {
  return me.name?.trim() || me.githubLogin;
}

export function ProfileButton() {
  const t = useT();
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const { data: runners = [] } = useQuery(runnersQuery);
  const runner = localRunnerOf(runners, me.member?.id);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="profile-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.shell.profileMenu}
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar
          person={{ name: displayName(me), avatarUrl: me.avatarUrl }}
          size={24}
          status={runner ? (runner.online ? "online" : "offline") : null}
        />
        <span className="profile-text">
          <span className="profile-name">{displayName(me)}</span>
          <span className="profile-runner">{runner ? runner.name : t.shell.noLocalRunner}</span>
        </span>
      </button>
      <ProfileMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={buttonRef}
        me={me}
        runner={runner}
      />
    </>
  );
}

function ProfileMenu({
  open,
  onClose,
  anchorRef,
  me,
  runner,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLButtonElement | null>;
  me: MeResponse;
  runner: Runner | null;
}) {
  const t = useT();
  const shell = useShell();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: () => logout(),
    onSuccess: async (loggedOut) => {
      if (!loggedOut) return;
      queryClient.clear();
      await navigate({ to: "/login" });
    },
  });

  return (
    <Floating
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      role="menu"
      aria-label={t.shell.profileMenu}
      className="profile-menu"
      // README：側欄底部的個人按鈕上方，左緣 10px
      position={(anchor) => ({
        left: Math.max(8, anchor.left + 2),
        bottom: window.innerHeight - anchor.top + 12,
      })}
    >
      <div className="profile-menu-header">
        <Avatar person={{ name: displayName(me), avatarUrl: me.avatarUrl }} size={32} />
        <div className="profile-menu-identity">
          <span className="profile-menu-name">{displayName(me)}</span>
          {/* TODO(backend, member-email)：/api/auth/me 沒有 email，先顯示 GitHub login */}
          <span className="profile-menu-sub">@{me.githubLogin}</span>
        </div>
        {me.member && (
          <span className="profile-menu-role" data-testid="member-role">
            {t.labels.role[me.member.role]}
          </span>
        )}
      </div>
      <hr className="profile-menu-separator" />
      <FluidList className="profile-menu-items" role="none">
        <button
          type="button"
          role="menuitem"
          className="profile-menu-item"
          {...fluidItem}
          onClick={() => {
            onClose();
            shell.openSettings("general");
          }}
        >
          <Settings size={14} className="profile-menu-icon" aria-hidden="true" />
          <span className="profile-menu-label">{t.shell.settings}</span>
          <Kbd bare>{shortcutLabel(",")}</Kbd>
        </button>
        <button
          type="button"
          role="menuitem"
          className="profile-menu-item"
          {...fluidItem}
          onClick={() => {
            onClose();
            shell.openSettings("runners");
          }}
        >
          <Monitor size={14} className="profile-menu-icon" aria-hidden="true" />
          <span className="profile-menu-label">{t.shell.runners}</span>
          <span className="profile-menu-runner">
            <StatusDot color={runner?.online ? "var(--o4fb86a)" : "var(--o8b9098)"} />
            {runner ? runner.name : t.shell.noLocalRunner}
          </span>
        </button>
        {me.member && me.member.role !== "viewer" && (
          <button
            type="button"
            role="menuitem"
            className="profile-menu-item"
            {...fluidItem}
            onClick={() => {
              onClose();
              void navigate({ to: "/admin" });
            }}
          >
            <Shield size={14} className="profile-menu-icon" aria-hidden="true" />
            <span className="profile-menu-label">{t.shell.admin}</span>
          </button>
        )}
      </FluidList>
      <hr className="profile-menu-separator" />
      <FluidList className="profile-menu-items" role="none">
        <button
          type="button"
          role="menuitem"
          className="profile-menu-item"
          disabled={signOut.isPending}
          {...fluidItem}
          onClick={() => signOut.mutate()}
        >
          <LogOut size={14} className="profile-menu-icon" aria-hidden="true" />
          <span className="profile-menu-label">{t.shell.signOut}</span>
        </button>
      </FluidList>
      <ErrorText error={signOut.error} />
    </Floating>
  );
}
