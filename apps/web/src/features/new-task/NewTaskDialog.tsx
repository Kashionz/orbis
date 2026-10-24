// 新增任務對話框（README §7）。完整內容在後續 commit 完成。

import { Dialog } from "../../components/Dialog";
import { useT } from "../../i18n";

export function NewTaskDialog({ onClose }: { projectId: string | undefined; onClose: () => void }) {
  const t = useT();
  return (
    <Dialog title={t.shell.board} open onClose={onClose} placement="top" width={680}>
      {null}
    </Dialog>
  );
}
