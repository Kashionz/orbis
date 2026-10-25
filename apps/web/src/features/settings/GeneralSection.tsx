// 設定→一般：主題、語言、預設版面、自動展開工具步驟、版本。

import { getDesktopBridge } from "@orbis/desktop/bridge";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Segmented } from "../../components/Segmented";
import { Switch } from "../../components/Switch";
import { useT } from "../../i18n";
import { LANGUAGES, LAYOUTS, THEME_PREFERENCES, usePreferences } from "../../lib/preferences";
import { resetPanelOpenOverride } from "../shell/use-panel";
import { healthQueryOptions } from "../version/api";
import { SettingRow } from "./SettingsDialog";

export function GeneralSection() {
  const t = useT();
  const preferences = usePreferences();
  return (
    <>
      <SettingRow label={t.settings.theme}>
        <Segmented
          label={t.settings.theme}
          value={preferences.theme}
          onChange={preferences.setTheme}
          options={THEME_PREFERENCES.map((value) => ({
            value,
            label: t.settings.themes[value],
          }))}
        />
      </SettingRow>
      <SettingRow label={t.settings.language}>
        <Segmented
          label={t.settings.language}
          value={preferences.language}
          onChange={preferences.setLanguage}
          options={LANGUAGES.map((value) => ({ value, label: t.settings.languages[value] }))}
        />
      </SettingRow>
      <SettingRow label={t.settings.defaultLayout}>
        <Segmented
          label={t.settings.defaultLayout}
          value={preferences.defaultLayout}
          onChange={(value) => {
            preferences.setDefaultLayout(value);
            resetPanelOpenOverride();
          }}
          options={LAYOUTS.map((value) => ({ value, label: t.settings.layouts[value] }))}
        />
      </SettingRow>
      <SettingRow label={t.settings.autoExpandTools}>
        <Switch
          label={t.settings.autoExpandTools}
          checked={preferences.autoExpandTools}
          onChange={preferences.setAutoExpandTools}
        />
      </SettingRow>
      <VersionRow />
    </>
  );
}

function VersionRow() {
  const t = useT();
  const { data: health } = useQuery(healthQueryOptions);
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null);
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    let cancelled = false;
    bridge
      .getVersion()
      .then((version) => {
        if (!cancelled) setDesktopVersion(version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <SettingRow label={t.settings.version}>
      <span className="setting-mono" data-testid="settings-version">
        {health?.versions && <span>{t.settings.versionServer(health.versions.server)}</span>}
        {desktopVersion && <span>{t.settings.versionDesktop(desktopVersion)}</span>}
      </span>
    </SettingRow>
  );
}
