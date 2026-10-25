// 分享卡（README §8、ADR-0012）：任務連結、一般存取、這個任務中的成員與邀請、加入成員（搜尋或 Email）。
// 送出後由 ShareCluster 在同一個位置顯示邀請成功卡。只有擁有者與 Admin 以上能修改（`task.share`），
// 其他人只能看。

import type {
  GeneralAccess,
  Member,
  Task,
  TaskInviteRole,
  TaskShareRole,
} from "@orbis/api-contract";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Copy, Link2, Lock, Users, X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { membersQuery } from "../../api/resources";
import { Avatar } from "../../components/Avatar";
import { IconButton } from "../../components/Button";
import { ErrorText } from "../../components/ErrorText";
import { Floating } from "../../components/Floating";
import { type MenuGroup, Popover, useMenu } from "../../components/Popover";
import { useToast } from "../../components/Toast";
import { type Messages, useT } from "../../i18n";
import { meQueryOptions } from "../auth/api";
import { usePermissions } from "../auth/use-permissions";
import { type ShareAddResult, useShareMutations, useTaskShare } from "./api";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const COPIED_MS = 1600;

/** 分享卡與邀請成功卡的位置：按鈕右下方，右緣對齊按鈕。 */
export function shareCardPosition(anchor: DOMRect) {
  const top = Math.round(anchor.bottom + 6);
  return {
    top,
    right: Math.max(12, Math.round(window.innerWidth - anchor.right)),
    maxHeight: Math.max(240, window.innerHeight - top - 12),
  };
}

export function taskLink(task: Pick<Task, "key">): string {
  return `${window.location.origin}/tasks/${encodeURIComponent(task.key)}`;
}

export function generalAccessText(t: Messages, general: GeneralAccess, team: string) {
  switch (general) {
    case "invited":
      return { label: t.share.general.invited, sub: t.share.generalSub.invited };
    case "team_view":
      return { label: t.share.general.teamView(team), sub: t.share.generalSub.teamView };
    case "team_edit":
      return { label: t.share.general.teamEdit(team), sub: t.share.generalSub.teamEdit };
  }
}

interface SharePopoverProps {
  open: boolean;
  task: Task;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onInvited: (result: ShareAddResult) => void;
}

export function SharePopover({ open, task, anchorRef, onClose, onInvited }: SharePopoverProps) {
  const t = useT();
  const searchRef = useRef<HTMLInputElement>(null);
  return (
    <Floating
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      role="dialog"
      aria-label={t.share.title(task.title)}
      className="share-card"
      position={shareCardPosition}
      initialFocusRef={searchRef}
    >
      <ShareCardBody task={task} searchRef={searchRef} onClose={onClose} onInvited={onInvited} />
    </Floating>
  );
}

function ShareCardBody({
  task,
  searchRef,
  onClose,
  onInvited,
}: {
  task: Task;
  searchRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onInvited: (result: ShareAddResult) => void;
}) {
  const t = useT();
  const toast = useToast();
  const canManage = usePermissions(null, task).can("task.share");
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const { data: members = [] } = useQuery(membersQuery);
  const { data: share, error: loadError } = useTaskShare(task.id);
  const mutations = useShareMutations(task.id);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [role, setRole] = useState<TaskInviteRole>("edit");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const team = me.member?.teamName ?? "";
  const inTask = new Set((share?.members ?? []).map((m) => m.memberId));
  const q = query.trim();
  const candidates = members.filter(
    (m) =>
      !inTask.has(m.id) &&
      (!q ||
        m.githubLogin.toLowerCase().includes(q.toLowerCase()) ||
        (m.name ?? "").toLowerCase().includes(q.toLowerCase())),
  );
  const typedEmail =
    EMAIL.test(q) &&
    !selected.includes(q) &&
    !(share?.invites ?? []).some((invite) => invite.email === q)
      ? q
      : null;
  const selectedEmails = selected.filter((value) => value.includes("@"));

  function toggle(value: string) {
    setSelected((current) =>
      current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== searchRef.current) return;
    if (event.key === "Escape" && query) {
      // 有搜尋字時 Esc 先清掉搜尋，不關閉分享卡（搜尋框有 data-own-escape）
      event.preventDefault();
      setQuery("");
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (typedEmail) {
        toggle(typedEmail);
        setQuery("");
        return;
      }
      const first = candidates.find((m) => !selected.includes(m.id));
      if (first) toggle(first.id);
    }
  }

  function invite() {
    if (selected.length === 0) return;
    const memberIds = selected.filter((value) => !value.includes("@"));
    const emails = selected.filter((value) => value.includes("@"));
    mutations.add.mutate(
      { memberIds, emails, role },
      {
        onSuccess: (result) => {
          onInvited(result);
          setSelected([]);
          setQuery("");
        },
      },
    );
  }

  const memberById = (id: string) => members.find((m) => m.id === id);

  return (
    <div className="share-card-inner" onKeyDownCapture={onKeyDown}>
      <div className="share-card-header">
        <span className="share-card-title">{t.share.title(task.title)}</span>
        <IconButton label={t.common.close} icon={<X size={16} />} onClick={onClose} />
      </div>
      <div className="share-card-body">
        <div className="share-access">
          <div className="share-link-row">
            <Link2 size={16} className="share-muted-icon" aria-hidden="true" />
            <span className="share-link" data-tip={taskLink(task)} data-tip-mono="">
              {taskLink(task).replace(/^https?:\/\//, "")}
            </span>
            <button
              type="button"
              className="share-copy"
              onClick={() => {
                void navigator.clipboard?.writeText(taskLink(task)).catch(() => {});
                setCopied(true);
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? t.common.copied : t.common.copy}
            </button>
          </div>
          <hr className="share-divider" />
          <GeneralAccessButton
            general={share?.generalAccess ?? task.generalAccess}
            team={team}
            disabled={!canManage}
            onChange={(general) => mutations.setGeneral.mutate(general)}
          />
        </div>

        <div className="share-section">
          <span className="share-section-title">{t.share.inThisTask}</span>
          {share?.members.map((entry) => {
            const member = memberById(entry.memberId);
            const name = member?.githubLogin ?? entry.memberId;
            return (
              <div key={entry.memberId} className="share-person">
                <Avatar person={{ name, avatarUrl: member?.avatarUrl }} size={24} />
                <span className="share-person-name">
                  {name}
                  {entry.memberId === me.member?.id && (
                    <span className="share-muted">{t.share.youSuffix}</span>
                  )}
                </span>
                {entry.role === "owner" || !canManage ? (
                  <span className="share-owner">{t.share.role[entry.role]}</span>
                ) : (
                  <MemberRoleButton
                    name={name}
                    role={entry.role}
                    onChange={(value) => {
                      if (value === "remove") {
                        mutations.remove.mutate(entry.memberId, {
                          onSuccess: () => toast.show(t.share.removed(name)),
                        });
                      } else mutations.setRole.mutate({ memberId: entry.memberId, role: value });
                    }}
                  />
                )}
              </div>
            );
          })}
          {share?.invites.map((invite) => (
            <div key={invite.id} className="share-person">
              <Avatar person={null} size={24} placeholder="@" />
              <span className="share-person-name">
                {invite.email}
                <span className="share-muted share-invited">{t.share.invited}</span>
              </span>
              {canManage && (
                <button
                  type="button"
                  className="share-text-button"
                  data-danger="true"
                  onClick={() =>
                    mutations.revoke.mutate(invite.id, {
                      onSuccess: () => toast.show(t.share.revoked),
                    })
                  }
                >
                  {t.share.revoke}
                </button>
              )}
            </div>
          ))}
        </div>

        {canManage && (
          <div className="share-section share-add">
            <span className="share-section-title">{t.share.addPeople}</span>
            <input
              ref={searchRef}
              className="share-search"
              value={query}
              placeholder={t.share.searchPlaceholder}
              aria-label={t.share.searchPlaceholder}
              autoComplete="off"
              data-own-escape={query ? "" : undefined}
              onChange={(event) => setQuery(event.target.value)}
            />
            {(candidates.length > 0 || selectedEmails.length > 0 || typedEmail) && (
              <div className="share-candidates">
                {candidates.map((member) => (
                  <CandidateTile
                    key={member.id}
                    label={member.githubLogin}
                    tooltip={member.name ?? member.githubLogin}
                    selected={selected.includes(member.id)}
                    onToggle={() => toggle(member.id)}
                    avatar={<MemberAvatar member={member} size={40} />}
                  />
                ))}
                {[...selectedEmails, ...(typedEmail ? [typedEmail] : [])].map((email) => (
                  <CandidateTile
                    key={email}
                    label={email.split("@")[0] ?? email}
                    tooltip={email}
                    selected={selected.includes(email)}
                    onToggle={() => {
                      toggle(email);
                      if (!selected.includes(email)) setQuery("");
                    }}
                    avatar={<Avatar person={null} size={40} placeholder="@" />}
                  />
                ))}
              </div>
            )}
            {candidates.length === 0 && !q && selectedEmails.length === 0 && (
              <span className="share-muted share-empty">{t.share.allJoined}</span>
            )}
          </div>
        )}
        {!canManage && <span className="share-muted share-readonly">{t.share.readOnly}</span>}
        <ErrorText
          error={
            loadError ??
            mutations.add.error ??
            mutations.setRole.error ??
            mutations.remove.error ??
            mutations.revoke.error ??
            mutations.setGeneral.error
          }
        />
      </div>
      {canManage && (
        <div className="share-card-footer">
          <InviteRoleButton role={role} onChange={setRole} />
          <button
            type="button"
            className="share-submit"
            disabled={selected.length === 0 || mutations.add.isPending}
            onClick={invite}
          >
            {t.share.addToTask(selected.length)}
          </button>
        </div>
      )}
    </div>
  );
}

function MemberAvatar({ member, size }: { member: Member; size: number }) {
  return <Avatar person={{ name: member.githubLogin, avatarUrl: member.avatarUrl }} size={size} />;
}

function CandidateTile({
  label,
  tooltip,
  selected,
  onToggle,
  avatar,
}: {
  label: string;
  tooltip: string;
  selected: boolean;
  onToggle: () => void;
  avatar: ReactNode;
}) {
  return (
    <button
      type="button"
      className="share-tile"
      aria-pressed={selected}
      data-tip={tooltip}
      onClick={onToggle}
    >
      <span className="share-tile-avatar" data-selected={selected}>
        {avatar}
        {selected && (
          <span className="share-tile-check" aria-hidden="true">
            <Check size={11} />
          </span>
        )}
      </span>
      <span className="share-tile-label">{label}</span>
    </button>
  );
}

function GeneralAccessButton({
  general: current,
  team,
  disabled,
  onChange,
}: {
  general: GeneralAccess;
  team: string;
  disabled: boolean;
  onChange: (general: GeneralAccess) => void;
}) {
  const t = useT();
  const menu = useMenu();
  const text = generalAccessText(t, current, team);
  const icon = (general: GeneralAccess, size: number) =>
    general === "invited" ? <Lock size={size} /> : <Users size={size} />;
  const groups: MenuGroup<GeneralAccess>[] = [
    {
      items: (["invited", "team_view", "team_edit"] as const).map((general) => ({
        value: general,
        ...generalAccessText(t, general, team),
        icon: icon(general, 14),
        checked: general === current,
      })),
    },
  ];
  return (
    <>
      <button
        ref={menu.anchorRef}
        type="button"
        className="share-general"
        aria-label={`${t.share.generalAccess}：${text.label}`}
        aria-disabled={disabled || undefined}
        {...(disabled ? {} : menu.triggerProps)}
      >
        <span className="share-muted-icon">{icon(current, 16)}</span>
        <span className="share-general-text">
          <span>{text.label}</span>
          <span className="share-muted share-ellipsis">{text.sub}</span>
        </span>
        <ChevronRight size={14} className="share-chevron-down" aria-hidden="true" />
      </button>
      <Popover
        {...menu.popoverProps}
        label={t.share.generalAccess}
        minWidth={320}
        prefer="down"
        groups={groups}
        onSelect={onChange}
      />
    </>
  );
}

function MemberRoleButton({
  name,
  role,
  onChange,
}: {
  name: string;
  role: TaskShareRole;
  onChange: (value: TaskShareRole | "remove") => void;
}) {
  const t = useT();
  const menu = useMenu();
  return (
    <>
      <button
        ref={menu.anchorRef}
        type="button"
        className="share-text-button share-role"
        aria-label={`${t.share.roleOf(name)}：${t.share.role[role]}`}
        {...menu.triggerProps}
      >
        {t.share.role[role]}
        <ChevronRight size={14} className="share-chevron-down" aria-hidden="true" />
      </button>
      <Popover<TaskShareRole | "remove">
        {...menu.popoverProps}
        label={t.share.roleOf(name)}
        minWidth={240}
        prefer="down"
        align="end"
        onSelect={onChange}
        groups={[
          {
            items: (["edit", "view"] as const).map((value) => ({
              value,
              label: t.share.role[value],
              sub: t.share.roleSub[value],
              checked: value === role,
            })),
          },
          {
            items: [
              { value: "owner", label: t.share.transferOwner, sub: t.share.transferOwnerSub },
            ],
          },
          { items: [{ value: "remove", label: t.share.removeAccess, danger: true }] },
        ]}
      />
    </>
  );
}

function InviteRoleButton({
  role,
  onChange,
}: {
  role: TaskInviteRole;
  onChange: (role: TaskInviteRole) => void;
}) {
  const t = useT();
  const menu = useMenu();
  return (
    <>
      <button
        ref={menu.anchorRef}
        type="button"
        className="share-invite-role"
        aria-label={`${t.share.inviteRole}：${t.share.role[role]}`}
        {...menu.triggerProps}
      >
        {t.share.role[role]}
        <ChevronRight size={14} className="share-chevron-down share-muted" aria-hidden="true" />
      </button>
      <Popover
        {...menu.popoverProps}
        label={t.share.inviteRole}
        minWidth={240}
        onSelect={onChange}
        groups={[
          {
            items: (["edit", "view"] as const).map((value) => ({
              value,
              label: t.share.role[value],
              sub: t.share.roleSub[value],
              checked: value === role,
            })),
          },
        ]}
      />
    </>
  );
}
