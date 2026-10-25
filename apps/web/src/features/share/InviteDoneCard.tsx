// 邀請成功卡（README §8）：在分享卡的位置顯示，沒有 scrim；Esc 或點外面關閉，「完成」預設 focus。
// 以 email 邀請時，邀請連結只在這裡出現一次：有寄信時顯示已寄出，沒有時提示複製連結傳給對方。

import type { Task } from "@orbis/api-contract";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { type RefObject, useRef } from "react";
import { membersQuery } from "../../api/resources";
import { Avatar } from "../../components/Avatar";
import { Floating } from "../../components/Floating";
import { useToast } from "../../components/Toast";
import { useT } from "../../i18n";
import type { ShareAddResult } from "./api";
import { shareCardPosition } from "./SharePopover";

export type InviteResult = ShareAddResult;

const MAX_ROWS = 4;

export function InviteDoneCard({
  result,
  task,
  anchorRef,
  onClose,
  onInviteMore,
}: {
  result: InviteResult | null;
  task: Task;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onInviteMore: () => void;
}) {
  const t = useT();
  const doneRef = useRef<HTMLButtonElement>(null);
  const toast = useToast();
  const { data: members = [] } = useQuery(membersQuery);
  const memberPerson = (id: string) => {
    const member = members.find((m) => m.id === id);
    return {
      key: id,
      name: member?.githubLogin ?? id,
      email: false,
      avatarUrl: member?.avatarUrl ?? null,
      link: null as { url: string; emailSent: boolean } | null,
    };
  };
  const people = [
    ...(result?.memberIds ?? []).map(memberPerson),
    ...(result?.invites ?? []).map((created) =>
      created.kind === "member_added"
        ? memberPerson(created.member.id)
        : {
            key: created.invite.id,
            name: created.invite.email,
            email: true,
            avatarUrl: null,
            link: { url: created.inviteUrl, emailSent: created.emailSent },
          },
    ),
  ];
  const [first] = people;
  const title =
    people.length === 1 && first
      ? t.share.invitedOne(first.name)
      : t.share.invitedMany(people.length);

  return (
    <Floating
      open={result !== null}
      onClose={onClose}
      anchorRef={anchorRef}
      role="alertdialog"
      aria-label={title}
      className="invite-done"
      position={shareCardPosition}
      initialFocusRef={doneRef}
    >
      <div className="invite-done-faces">
        {people.slice(0, 3).map((person, index) => (
          <Avatar
            key={person.key}
            person={person.email ? null : { name: person.name, avatarUrl: person.avatarUrl }}
            placeholder="@"
            filledPlaceholder
            size={52}
            ring
            style={{ marginLeft: index === 0 ? 0 : -14, zIndex: 5 - index }}
          />
        ))}
        <span className="invite-done-check" aria-hidden="true">
          <Check size={13} />
        </span>
      </div>
      <div className="invite-done-text">
        <span className="invite-done-title">{title}</span>
        <span className="invite-done-sub">{t.share.addedTo(task.title)}</span>
      </div>
      <div className="invite-done-list">
        {people.slice(0, MAX_ROWS).map((person) => (
          <div key={person.key} className="invite-done-row">
            <Avatar
              person={person.email ? null : { name: person.name, avatarUrl: person.avatarUrl }}
              placeholder="@"
              size={22}
            />
            <span className="invite-done-name">
              <span>{person.name}</span>
              {person.link && (
                <span className="invite-done-email">
                  {person.link.emailSent ? t.share.emailSent : t.share.copyLinkToSend}
                </span>
              )}
            </span>
            {person.link && (
              <button
                type="button"
                className="share-text-button"
                aria-label={t.share.copyInviteLink}
                data-tip={t.share.copyInviteLink}
                onClick={() => {
                  const url = person.link?.url ?? "";
                  void navigator.clipboard?.writeText(url).then(() => toast.show(t.common.copied));
                }}
              >
                <Copy size={13} />
              </button>
            )}
            <span className="invite-done-role">{result ? t.share.role[result.role] : ""}</span>
          </div>
        ))}
        {people.length > MAX_ROWS && (
          <div className="invite-done-more">+{people.length - MAX_ROWS}</div>
        )}
      </div>
      <div className="invite-done-actions">
        <button type="button" className="share-secondary" onClick={onInviteMore}>
          {t.share.inviteMore}
        </button>
        <button ref={doneRef} type="button" className="share-submit" onClick={onClose}>
          {t.share.done}
        </button>
      </div>
    </Floating>
  );
}
