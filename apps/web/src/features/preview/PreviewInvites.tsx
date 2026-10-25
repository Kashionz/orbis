// 預覽邀請（ADR-0015）：把 Preview 分享給特定的人（GitHub 帳號或 email），每人各自一條連結與期限，
// 可以個別撤銷；名單顯示期限與最後一次開啟的時間。Team 設定「允許對外分享預覽」關閉時只顯示說明。

import {
  API_ROUTES,
  apiPath,
  type PreviewInviteCreated as Created,
  type PreviewInvite,
  PreviewInviteCreated,
  type PreviewInviteDuration,
  PreviewInviteListResponse,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { type FormEvent, useState } from "react";
import { apiRequest, apiSend } from "../../api/client";
import { teamQuery } from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { useToast } from "../../components/Toast";
import { useT } from "../../i18n";
import { formatTime } from "../../lib/format";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DURATIONS: readonly PreviewInviteDuration[] = ["1h", "24h", "7d"];

export const previewInvitesQuery = (runId: string) => ({
  queryKey: ["runs", runId, "preview-invites"] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    apiRequest(apiPath(API_ROUTES.runPreviewInvites, { runId }), PreviewInviteListResponse, {
      signal,
    }),
});

function createInvite(
  runId: string,
  who: string,
  duration: PreviewInviteDuration,
): Promise<Created> {
  const body = EMAIL.test(who)
    ? { email: who, duration }
    : { githubLogin: who.replace(/^@/, ""), duration };
  return apiRequest(apiPath(API_ROUTES.runPreviewInvites, { runId }), PreviewInviteCreated, {
    method: "POST",
    body,
  });
}

function revokeInvite(runId: string, inviteId: string): Promise<void> {
  return apiSend(apiPath(API_ROUTES.runPreviewInvite, { runId, inviteId }), { method: "DELETE" });
}

export function PreviewInvites({ runId }: { runId: string }) {
  const t = useT();
  const p = t.workspace.preview.invites;
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: team } = useQuery(teamQuery);
  const allowed = team?.allowExternalPreview ?? false;
  const query = previewInvitesQuery(runId);
  const { data: invites = [], error } = useQuery({ ...query, enabled: allowed });
  const [who, setWho] = useState("");
  const [duration, setDuration] = useState<PreviewInviteDuration>("24h");
  const [created, setCreated] = useState<Created | null>(null);
  const invite = useMutation({
    mutationFn: () => createInvite(runId, who.trim(), duration),
    onSuccess: (result) => {
      setCreated(result);
      setWho("");
      void queryClient.invalidateQueries({ queryKey: query.queryKey });
    },
  });
  const revoke = useMutation({
    mutationFn: (inviteId: string) => revokeInvite(runId, inviteId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: query.queryKey }),
  });

  if (!team) return null;
  if (!allowed) {
    return (
      <section className="pv-invites" aria-label={p.title}>
        <p className="pv-muted">{p.disabled}</p>
      </section>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (who.trim() !== "") invite.mutate();
  }

  const copy = (url: string) =>
    void navigator.clipboard?.writeText(url).then(() => toast.show(t.common.copied));

  return (
    <section className="pv-invites" aria-label={p.title}>
      <span className="pv-invites-title">{p.title}</span>
      <form className="pv-invites-form" onSubmit={submit}>
        <input
          className="pv-invites-input"
          value={who}
          placeholder={p.placeholder}
          aria-label={p.placeholder}
          onChange={(event) => setWho(event.target.value)}
        />
        <select
          className="pv-invites-select"
          value={duration}
          aria-label={p.duration}
          onChange={(event) => setDuration(event.target.value as PreviewInviteDuration)}
        >
          {DURATIONS.map((value) => (
            <option key={value} value={value}>
              {p.durationOption[value]}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="o-btn"
          data-variant="primary"
          disabled={invite.isPending || who.trim() === ""}
        >
          {p.invite}
        </button>
      </form>
      <ErrorText error={invite.error ?? revoke.error ?? error} />
      {created && (
        <div className="pv-invites-created" role="status">
          <span>{created.emailSent ? p.emailSent : p.copyLink}</span>
          <code className="pv-invites-link">{created.inviteUrl}</code>
          <button
            type="button"
            className="pv-icon-btn"
            aria-label={p.copyLinkButton}
            data-tip={p.copyLinkButton}
            onClick={() => copy(created.inviteUrl)}
          >
            <Copy size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {invites.length > 0 && (
        <ul className="pv-invites-list">
          {invites.map((item) => (
            <InviteRow
              key={item.id}
              invite={item}
              revoking={revoke.isPending && revoke.variables === item.id}
              onRevoke={() => revoke.mutate(item.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function InviteRow({
  invite,
  revoking,
  onRevoke,
}: {
  invite: PreviewInvite;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const t = useT();
  const p = t.workspace.preview.invites;
  const who = invite.githubLogin ? `@${invite.githubLogin}` : (invite.email ?? "");
  return (
    <li className="pv-invites-row" data-status={invite.status}>
      <span className="pv-invites-who">{who}</span>
      <span className="pv-muted">{p.status[invite.status]}</span>
      <span className="pv-muted">
        {invite.status === "active" && p.expiresAt(formatTime(invite.expiresAt))}
      </span>
      <span className="pv-muted">
        {invite.lastOpenedAt ? p.lastOpened(formatTime(invite.lastOpenedAt)) : p.neverOpened}
      </span>
      {invite.status === "active" && (
        <button type="button" className="pv-invites-revoke" disabled={revoking} onClick={onRevoke}>
          {p.revoke}
        </button>
      )}
    </li>
  );
}
