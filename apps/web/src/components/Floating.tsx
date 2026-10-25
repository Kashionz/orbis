// 不是選單的浮層（個人選單、分享卡、邀請成功卡）：固定位置、Esc 與點外面關閉、關閉後 focus 回到觸發按鈕。
// 位置由呼叫端依 anchor 計算（`position(anchorRect)`）。

import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useLayer } from "./layers";

type FloatingProps = Omit<HTMLAttributes<HTMLDivElement>, "style"> & {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  position: (anchor: DOMRect) => CSSProperties;
  /** 開啟後要 focus 的元素（預設浮層本身）。 */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 點外面時是否關閉（預設會）。 */
  closeOnOutside?: boolean;
  children: ReactNode;
};

export function Floating({
  open,
  onClose,
  anchorRef,
  position,
  initialFocusRef,
  closeOnOutside = true,
  className,
  children,
  ...rest
}: FloatingProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  const close = useCallback(() => {
    onClose();
    anchorRef.current?.focus();
  }, [onClose, anchorRef]);

  useLayer(open, close);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在開啟時定位
  useLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    const anchor = anchorRef.current;
    setStyle(position(anchor ? anchor.getBoundingClientRect() : new DOMRect()));
  }, [open]);

  useEffect(() => {
    if (!open || !style) return;
    (initialFocusRef?.current ?? ref.current)?.focus({ preventScroll: true });
  }, [open, style, initialFocusRef]);

  useEffect(() => {
    if (!open || !closeOnOutside) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      // 從這個浮層開出的 Popover 在 body 底下，點它不算點外面
      if ((target as Element).closest?.(".o-popover")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, closeOnOutside, onClose, anchorRef]);

  if (!open || !style) return null;
  return createPortal(
    <div
      {...rest}
      ref={ref}
      tabIndex={-1}
      className={["o-floating", className].filter(Boolean).join(" ")}
      style={{ position: "fixed", ...style }}
    >
      {children}
    </div>,
    document.body,
  );
}
