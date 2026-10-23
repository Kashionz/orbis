import {
  NOTIFICATION_KINDS,
  type NotificationKind,
  NotificationPreferences,
} from "@orbis/api-contract";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  notificationPreferencesQuery,
  queryKeys,
  updateNotificationPreferences,
} from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { NOTIFICATION_KIND_LABELS } from "../../lib/labels";

/** 瀏覽器的時區，作為勿擾時段的預設值。 */
function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** 可以選的時區；瀏覽器不支援列出時只提供目前的時區。 */
function timeZones(current: string): string[] {
  const zones =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return zones.includes(current) ? zones : [current, ...zones];
}

/**
 * 個人的通知設定（ARCHITECTURE §12.3）：依事件類型關閉（App 內與桌面都不送）；
 * 勿擾時段只抑制桌面推送，App 內照常記錄，結束後也不補推。
 */
export function NotificationSettingsPage() {
  const queryClient = useQueryClient();
  const { data: saved } = useSuspenseQuery(notificationPreferencesQuery);
  const [disabled, setDisabled] = useState<ReadonlySet<NotificationKind>>(
    () => new Set(saved.disabledKinds),
  );
  const [quiet, setQuiet] = useState(saved.quietHours !== null);
  const [start, setStart] = useState(saved.quietHours?.start ?? "22:00");
  const [end, setEnd] = useState(saved.quietHours?.end ?? "08:00");
  const [timeZone, setTimeZone] = useState(saved.quietHours?.timeZone ?? browserTimeZone());
  const [issues, setIssues] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: updateNotificationPreferences,
    onSuccess: (updated) => queryClient.setQueryData(queryKeys.notificationPreferences, updated),
  });

  function toggle(kind: NotificationKind, enabled: boolean) {
    setDisabled((current) => {
      const next = new Set(current);
      if (enabled) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  return (
    <main className="settings-page notification-settings">
      <nav className="breadcrumb">
        <Link to="/notifications">通知</Link>
        <span aria-hidden="true"> / </span>
        <span>通知設定</span>
      </nav>
      <header className="page-header">
        <h1>通知設定</h1>
      </header>
      <form
        className="settings-form"
        aria-label="通知設定"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = NotificationPreferences.safeParse({
            disabledKinds: NOTIFICATION_KINDS.filter((k) => disabled.has(k)),
            quietHours: quiet ? { start, end, timeZone } : null,
          });
          if (!parsed.success) {
            setIssues(parsed.error.issues.map((issue) => issue.message));
            return;
          }
          setIssues([]);
          save.mutate(parsed.data);
        }}
      >
        <fieldset>
          <legend>要收到的通知</legend>
          <p className="hint">關閉的事件類型在 App 內與桌面都不會通知。</p>
          {NOTIFICATION_KINDS.map((kind) => (
            <label key={kind} className="field-inline">
              <input
                type="checkbox"
                checked={!disabled.has(kind)}
                onChange={(event) => toggle(kind, event.target.checked)}
              />
              {NOTIFICATION_KIND_LABELS[kind]}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>勿擾時段</legend>
          <p className="hint">只暫停桌面通知；App 內照常記錄，時段結束後也不會補推。</p>
          <label className="field-inline">
            <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
            設定勿擾時段
          </label>
          {quiet && (
            <div className="quiet-hours">
              <label className="field-inline">
                開始
                <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
              <label className="field-inline">
                結束
                <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
              </label>
              <label className="field-inline">
                時區
                <select value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
                  {timeZones(timeZone).map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </label>
              <span className="hint">開始晚於結束表示跨午夜，例如 22:00–08:00。</span>
            </div>
          )}
        </fieldset>
        {issues.length > 0 && (
          <ul className="error-text" role="alert">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        <ErrorText error={save.error} />
        {save.isSuccess && (
          <p className="hint" role="status">
            已儲存
          </p>
        )}
        <button type="submit" className="primary" disabled={save.isPending}>
          儲存通知設定
        </button>
      </form>
    </main>
  );
}
