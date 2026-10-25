import type { Project, Run, Task } from "@orbis/api-contract";
import { Dialog } from "../../components/Dialog";
import { useT } from "../../i18n";
import { DispatchForm } from "./DispatchForm";

interface DispatchDialogProps {
  task: Task;
  project: Project;
  open: boolean;
  onClose: () => void;
  onDispatched: (run: Run) => void;
}

/** 派工對話框（看板拖到執行中時）：內容和工作區的派工表單相同。 */
export function DispatchDialog({
  task,
  project,
  open,
  onClose,
  onDispatched,
}: DispatchDialogProps) {
  const t = useT();
  return (
    <Dialog
      title={t.workspace.noRun.dispatchTitle(task.key)}
      open={open}
      onClose={onClose}
      width={560}
    >
      {open && (
        <DispatchForm
          task={task}
          project={project}
          onDispatched={onDispatched}
          onCancel={onClose}
        />
      )}
    </Dialog>
  );
}
