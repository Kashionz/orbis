// 對話框的底層：scrim、置中或靠上（10vh）的面板、focus 留在對話框內、關閉後 focus 回到原處。
// Esc 只關最上層（layers.ts）；點 scrim 關閉。

import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useLayer } from "./layers";
import "./Modal.css";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** 無障礙名稱（對話框的標題）；有可見標題時改用 `labelledBy`。 */
  label?: string;
  labelledBy?: string;
  placement?: "center" | "top";
  className?: string;
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  label,
  labelledBy,
  placement = "center",
  className,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useLayer(open, onClose);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // 有 autoFocus 的欄位時交給它，否則 focus 面板本身
    if (panel && !panel.contains(document.activeElement)) panel.focus();
    return () => {
      const target = returnFocusRef.current;
      if (target?.isConnected) target.focus();
    };
  }, [open]);

  if (!open) return null;

  function trapTab(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => element.getClientRects().length > 0,
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      className="o-modal-scrim"
      data-placement={placement}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={["o-modal", className].filter(Boolean).join(" ")}
        onKeyDown={trapTab}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
