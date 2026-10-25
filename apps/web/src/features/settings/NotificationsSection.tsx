// 設定→通知（ARCHITECTURE §12.3）：依事件類型關閉通知（App 內與桌面都不送）、勿擾時段（只抑制桌面推送）。
// 每次切換立即儲存。

import {
  NOTIFICATION_KINDS,
  type NotificationKind,
  NotificationPreferences,
  type QuietHours,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  notificationPreferencesQuery,
  queryKeys,
  updateNotificationPreferences,
} from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { Switch } from "../../components/Switch";
import { useT } from "../../i18n";
import { useDesktopNotificationSetting } from "./api";
import { SettingRow } from "./SettingsDialog";

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

const DEFAULT_QUIET_HOURS = { start: "22:00", end: "08:00" };

export function NotificationsSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: saved, error: loadError } = useQuery(notificationPreferencesQuery);
  const [issues, setIssues] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: updateNotificationPreferences,
    onSuccess: (updated) => queryClient.setQueryData(queryKeys.notificationPreferences, updated),
  });

  function commit(next: NotificationPreferences) {
    const parsed = NotificationPreferences.safeParse(next);
    if (!parsed.success) {
      setIssues(parsed.error.issues.map((issue) => issue.message));
      return;
    }
    setIssues([]);
    // 先更新畫面，失敗時由下一次讀取還原
    queryClient.setQueryData(queryKeys.notificationPreferences, parsed.data);
    save.mutate(parsed.data, {
      onError: () =>
        void queryClient.invalidateQueries({ queryKey: queryKeys.notificationPreferences }),
    });
  }

  if (!saved) return <ErrorText error={loadError} />;
  const disabled = new Set(saved.disabledKinds);

  function toggle(kind: NotificationKind, enabled: boolean) {
    if (!saved) return;
    const next = new Set(disabled);
    if (enabled) next.delete(kind);
    else next.add(kind);
    commit({ ...saved, disabledKinds: NOTIFICATION_KINDS.filter((k) => next.has(k)) });
  }

  function setQuiet(quietHours: QuietHours | null) {
    if (!saved) return;
    commit({ ...saved, quietHours });
  }

  return (
    <>
      <DesktopNotificationsRow />
      {NOTIFICATION_KINDS.map((kind) => (
        <SettingRow key={kind} label={t.labels.notificationKind[kind]}>
          <Switch
            label={t.labels.notificationKind[kind]}
            checked={!disabled.has(kind)}
            onChange={(enabled) => toggle(kind, enabled)}
          />
        </SettingRow>
      ))}
      <SettingRow label={t.settings.quietHours}>
        <Switch
          label={t.settings.quietHours}
          checked={saved.quietHours !== null}
          onChange={(on) =>
            setQuiet(on ? { ...DEFAULT_QUIET_HOURS, timeZone: browserTimeZone() } : null)
          }
        />
      </SettingRow>
      {saved.quietHours && <QuietHoursFields value={saved.quietHours} onChange={setQuiet} />}
      {issues.length > 0 && (
        <ul className="error-text" role="alert">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <ErrorText error={save.error} />
    </>
  );
}

function QuietHoursFields({
  value,
  onChange,
}: {
  value: QuietHours;
  onChange: (value: QuietHours) => void;
}) {
  const t = useT();
  return (
    <div className="settings-quiet">
      <label className="settings-field">
        <span>{t.settings.quietHoursFrom}</span>
        <input
          type="time"
          value={value.start}
          onChange={(event) => onChange({ ...value, start: event.target.value })}
        />
      </label>
      <label className="settings-field">
        <span>{t.settings.quietHoursTo}</span>
        <input
          type="time"
          value={value.end}
          onChange={(event) => onChange({ ...value, end: event.target.value })}
        />
      </label>
      <label className="settings-field settings-field-wide">
        <span>{t.settings.timeZone}</span>
        <select
          value={value.timeZone}
          onChange={(event) => onChange({ ...value, timeZone: event.target.value })}
        >
          {timeZones(value.timeZone).map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** 桌面通知總開關：每台電腦各自決定，存在 Desktop 的設定檔；Web 版不顯示。 */
function DesktopNotificationsRow() {
  const t = useT();
  const { available, query, update } = useDesktopNotificationSetting();
  if (!available) return null;
  const checked = update.variables ?? query.data ?? true;
  return (
    <SettingRow label={t.settings.desktopNotifications}>
      <Switch
        label={t.settings.desktopNotifications}
        checked={checked}
        disabled={query.isPending || update.isPending}
        onChange={(value) => update.mutate(value)}
      />
    </SettingRow>
  );
}
