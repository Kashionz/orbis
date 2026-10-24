// 設定對話框（README §9）。完整內容在後續 commit 完成。

import { Dialog } from "../../components/Dialog";
import { useT } from "../../i18n";
import type { SettingsTab } from "./tabs";

export function SettingsDialog({
  onClose,
}: {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog title={t.shell.settings} open onClose={onClose} width={820}>
      {null}
    </Dialog>
  );
}
