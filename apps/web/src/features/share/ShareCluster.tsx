// 工作區標題列右側的分享區塊（README §2 Header）：成員頭像堆疊＋分享按鈕，按下開啟分享卡。
// 標題列寬度 < 620px 時隱藏頭像，< 480px 時分享按鈕只剩圖示（仍有 aria-label 與 Tooltip）。

import type { Task } from "@orbis/api-contract";
import { useQuery } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import { useRef, useState } from "react";
import { membersQuery } from "../../api/resources";
import { AvatarStack } from "../../components/Avatar";
import { useT } from "../../i18n";
import { useTaskShare } from "./api";
import { InviteDoneCard, type InviteResult } from "./InviteDoneCard";
import { SharePopover } from "./SharePopover";
import "./share.css";

/** 標題列寬度低於這個值時隱藏頭像。 */
export const SHARE_AVATARS_MIN_WIDTH = 620;
/** 標題列寬度低於這個值時分享按鈕只剩圖示。 */
export const SHARE_LABEL_MIN_WIDTH = 480;

export function ShareCluster({ task, headerWidth }: { task: Task; headerWidth: number }) {
  const t = useT();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<InviteResult | null>(null);
  const { data: share } = useTaskShare(task.id);
  const { data: members = [] } = useQuery(membersQuery);
  const wide = headerWidth === 0 || headerWidth >= SHARE_AVATARS_MIN_WIDTH;
  const withLabel = headerWidth === 0 || headerWidth >= SHARE_LABEL_MIN_WIDTH;

  const people = (share?.members ?? []).flatMap((entry) => {
    const member = members.find((m) => m.id === entry.memberId);
    return member ? [{ name: member.githubLogin, avatarUrl: member.avatarUrl }] : [];
  });

  return (
    <div className="share-cluster">
      {wide && people.length > 0 && (
        <span className="share-faces" aria-hidden="true">
          <AvatarStack people={people} size={22} max={3} />
        </span>
      )}
      <button
        ref={buttonRef}
        type="button"
        className="share-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t.share.share}
        data-tip={withLabel ? undefined : t.share.share}
        onClick={() => {
          setResult(null);
          setOpen((value) => !value);
        }}
      >
        <Share2 size={14} aria-hidden="true" />
        {withLabel && <span>{t.share.share}</span>}
      </button>
      <>
        <SharePopover
          open={open}
          task={task}
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
          onInvited={(invited) => {
            setOpen(false);
            setResult(invited);
          }}
        />
        <InviteDoneCard
          result={result}
          task={task}
          anchorRef={buttonRef}
          onClose={() => setResult(null)}
          onInviteMore={() => {
            setResult(null);
            setOpen(true);
          }}
        />
      </>
    </div>
  );
}
