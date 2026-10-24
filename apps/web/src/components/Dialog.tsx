import { X } from "lucide-react";
import { type ReactNode, useId } from "react";
import { useT } from "../i18n";
import { IconButton } from "./Button";
import { Modal } from "./Modal";
import "./Dialog.css";

interface DialogProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 標題旁的次要文字（例如下一個 Task Key）。 */
  titleAside?: ReactNode;
  placement?: "center" | "top";
  width?: number;
  className?: string;
}

/** 有標題列與關閉鈕的一般對話框（Esc 只關最上層、focus 留在對話框內）。 */
export function Dialog({
  title,
  open,
  onClose,
  children,
  titleAside,
  placement = "center",
  width = 520,
  className,
}: DialogProps) {
  const t = useT();
  const titleId = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      placement={placement}
      className={["o-dialog", className].filter(Boolean).join(" ")}
    >
      <div className="o-dialog-panel" style={{ width: `min(${width}px, 100%)` }}>
        <div className="o-dialog-header">
          <h2 id={titleId} className="o-dialog-title">
            {title}
          </h2>
          {titleAside}
          <span className="o-dialog-spacer" />
          <IconButton label={t.common.close} icon={<X size={16} />} onClick={onClose} />
        </div>
        <div className="o-dialog-body">{children}</div>
      </div>
    </Modal>
  );
}
