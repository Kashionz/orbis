// 設定對話框（README §9）：左側導覽（一般、執行器、代理、通知、帳號），右側內容。
// Ctrl+, 開啟；Esc 關最上層；個人選單的「執行器」直接開執行器分頁。

import { Bell, Bot, Server, Settings, User, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId } from "react";
import { IconButton } from "../../components/Button";
import { FluidList, fluidItem } from "../../components/FluidList";
import { Modal } from "../../components/Modal";
import { useT } from "../../i18n";
import { AccountSection } from "./AccountSection";
import { AgentsSection } from "./AgentsSection";
import { GeneralSection } from "./GeneralSection";
import { NotificationsSection } from "./NotificationsSection";
import { RunnersSettingsSection } from "./RunnersSettingsSection";
import { SETTINGS_TABS, type SettingsTab } from "./tabs";
import "./settings.css";

const TAB_ICONS: Record<SettingsTab, ReactNode> = {
  general: <Settings size={14} />,
  runners: <Server size={14} />,
  agents: <Bot size={14} />,
  notifications: <Bell size={14} />,
  account: <User size={14} />,
};

interface SettingsDialogProps {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onClose: () => void;
}

export function SettingsDialog({ tab, onTabChange, onClose }: SettingsDialogProps) {
  const t = useT();
  const baseId = useId();
  const tabId = (value: SettingsTab) => `${baseId}-tab-${value}`;
  const panelId = `${baseId}-panel`;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = SETTINGS_TABS.indexOf(tab);
    const next =
      SETTINGS_TABS[
        (index + (event.key === "ArrowDown" ? 1 : -1) + SETTINGS_TABS.length) % SETTINGS_TABS.length
      ];
    if (!next) return;
    onTabChange(next);
    document.getElementById(tabId(next))?.focus();
  }

  return (
    <Modal open onClose={onClose} label={t.settings.title} className="settings-dialog">
      <div className="settings">
        <div className="settings-nav">
          <span className="settings-nav-title">{t.settings.title}</span>
          <FluidList
            role="tablist"
            aria-orientation="vertical"
            aria-label={t.settings.title}
            className="settings-tabs"
            onKeyDown={onKeyDown}
          >
            {SETTINGS_TABS.map((value) => {
              const active = value === tab;
              return (
                <button
                  key={value}
                  id={tabId(value)}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={panelId}
                  tabIndex={active ? 0 : -1}
                  className="settings-tab"
                  {...fluidItem}
                  onClick={() => onTabChange(value)}
                >
                  <span className="settings-tab-icon">{TAB_ICONS[value]}</span>
                  <span className="o-wstable">
                    <span className="o-wstable-text" data-active={active}>
                      {t.settings.nav[value]}
                    </span>
                    <span className="o-wstable-ghost" aria-hidden="true">
                      {t.settings.nav[value]}
                    </span>
                  </span>
                </button>
              );
            })}
          </FluidList>
        </div>
        <div className="settings-main">
          <div className="settings-close">
            <IconButton label={t.common.close} icon={<X size={16} />} onClick={onClose} />
          </div>
          <div
            id={panelId}
            role="tabpanel"
            aria-labelledby={tabId(tab)}
            className="settings-content"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: tabpanel 可以 focus，讓鍵盤使用者捲動內容
            tabIndex={0}
          >
            <div key={tab} className="settings-section o-fade-in">
              <h2 className="settings-heading">{t.settings.nav[tab]}</h2>
              {tab === "general" && <GeneralSection />}
              {tab === "runners" && <RunnersSettingsSection />}
              {tab === "agents" && <AgentsSection />}
              {tab === "notifications" && <NotificationsSection />}
              {tab === "account" && <AccountSection onLeave={onClose} />}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** 設定的一列：左邊標題（可加說明），右邊控制項；列之間有細分隔線。 */
export function SettingRow({
  label,
  labelId,
  children,
  sub,
}: {
  label: ReactNode;
  labelId?: string;
  children?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="setting-row">
      <span className="setting-label" id={labelId}>
        <span>{label}</span>
        {sub && <span className="setting-sub">{sub}</span>}
      </span>
      {children}
    </div>
  );
}
