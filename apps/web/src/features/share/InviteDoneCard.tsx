// 邀請成功卡（README §8）：在分享卡的位置顯示，沒有 scrim；Esc 或點外面關閉，「完成」預設 focus。

import type { Task } from "@orbis/api-contract";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { type RefObject, useRef } from "react";
import { membersQuery } from "../../api/resources";
import { Avatar } from "../../components/Avatar";
import { Floating } from "../../components/Floating";
import { useT } from "../../i18n";
import { shareCardPosition } from "./SharePopover";
import type { InviteRole } from "./types";

export interface InviteResult {
  /** 加入的 Member id 或 Email。 */
  who: string[];
  role: InviteRole;
}

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
  const { data: members = [] } = useQuery(membersQuery);
  const people = (result?.who ?? []).map((value) => {
    if (value.includes("@")) return { key: value, name: value, email: true, avatarUrl: null };
    const member = members.find((m) => m.id === value);
    return {
      key: value,
      name: member?.githubLogin ?? value,
      email: false,
      avatarUrl: member?.avatarUrl ?? null,
    };
  });
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
              {person.email && <span className="invite-done-email">{t.share.emailInvite}</span>}
            </span>
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
