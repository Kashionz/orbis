// 共用的 Popover 選單（README「Composer menus」）：群組標題（logo、標題、vendor）、單行子說明、
// tag、勾選、固定 pill、停用項目的 Tooltip。自動上下翻轉，高度上限是可用空間，超過時內部捲動。
// Esc、點外面、Tab 關閉；↑↓ Home End 移動、Enter 或空白鍵選取；關閉後 focus 回到觸發按鈕。

import { Check } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { FluidList, fluidItem } from "./FluidList";
import { type MenuPlacement, placeMenu, type VerticalPreference } from "./geometry";
import { useLayer } from "./layers";
import "./Popover.css";

export interface MenuItem<V> {
  value: V;
  label: ReactNode;
  /** 子說明，單行，超出省略。 */
  sub?: string;
  /** 右側的 tag pill（例如「最強」）。 */
  tag?: string;
  /** 左側圖示或頭像。 */
  icon?: ReactNode;
  /** 樹狀縮排的前綴（等寬字，例如 `└`）。 */
  tree?: string;
  checked?: boolean;
  disabled?: boolean;
  /** 停用時的說明（Tooltip）。 */
  disabledReason?: string;
  /** 不能選、只顯示的固定值 pill（例如「固定」）。 */
  fixed?: string;
  mono?: boolean;
  danger?: boolean;
  /** 給 e2e 與無障礙用的名稱（label 不是純文字時）。 */
  ariaLabel?: string;
}

export interface MenuGroup<V> {
  title?: ReactNode;
  /** 標題旁的次要文字（例如 vendor）。 */
  titleSub?: string;
  logo?: ReactNode;
  /** 標題用等寬字（例如路徑）。 */
  titleMono?: boolean;
  items: MenuItem<V>[];
}

interface PopoverProps<V> {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  groups: MenuGroup<V>[];
  onSelect: (value: V) => void;
  /** 無障礙名稱。 */
  label: string;
  prefer?: VerticalPreference;
  align?: "start" | "end";
  minWidth?: number;
  /** 額外加寬（模型選單要多 20px 放 tag）。 */
  extraWidth?: number;
  /** 項目選取後要不要關閉（預設會）。 */
  closeOnSelect?: boolean;
  /** 單選選單用 menuitemradio，其他用 menuitem。 */
  selectable?: boolean;
}

/** 預估一組選單的高度，決定往上或往下開。 */
export function estimateMenuHeight<V>(groups: MenuGroup<V>[]): number {
  return (
    12 +
    groups.reduce(
      (sum, group) =>
        sum +
        (group.title ? 28 : 0) +
        group.items.reduce((total, item) => total + (item.sub ? 56 : 32), 0),
      0,
    ) +
    Math.max(0, groups.length - 1) * 9
  );
}

function focusableItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(
    menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])'),
  );
}

export function Popover<V>({
  anchorRef,
  open,
  onClose,
  groups,
  onSelect,
  label,
  prefer = "auto",
  align = "start",
  minWidth = 220,
  extraWidth = 0,
  closeOnSelect = true,
  selectable = true,
}: PopoverProps<V>) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<(MenuPlacement & { width: number }) | null>(null);
  const id = useId();

  const close = useCallback(() => {
    onClose();
    anchorRef.current?.focus();
  }, [onClose, anchorRef]);

  useLayer(open, close);

  // 開啟時以 anchor 的位置計算方向與寬度；內容改變（例如勾選）不重新翻轉
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在開關時重新定位
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.max(minWidth, Math.round(rect.width)) + extraWidth;
    setPlacement({
      ...placeMenu({
        anchor: rect,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        estimatedHeight: estimateMenuHeight(groups),
        width,
        prefer,
        align,
      }),
      width,
    });
  }, [open]);

  // 開啟後 focus 已勾選的項目，沒有時 focus 第一個
  useEffect(() => {
    if (!open || !placement) return;
    const items = focusableItems(menuRef.current);
    const checked = items.find((item) => item.getAttribute("aria-checked") === "true");
    (checked ?? items[0])?.focus({ preventScroll: true });
  }, [open, placement]);

  // 點外面關閉（點觸發按鈕交給按鈕自己切換）
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, onClose, anchorRef]);

  // 視窗大小改變，或外層捲動讓按鈕移動時關閉，避免選單和按鈕分開
  useEffect(() => {
    if (!open) return;
    const start = anchorRef.current?.getBoundingClientRect();
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      const now = anchorRef.current?.getBoundingClientRect();
      if (!start || !now) return;
      if (Math.abs(now.top - start.top) > 2 || Math.abs(now.left - start.left) > 2) onClose();
    };
    window.addEventListener("resize", onClose);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onClose);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !placement) return null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = focusableItems(menuRef.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index <= 0 ? items.length - 1 : index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(items.length - 1);
        break;
      case "Tab":
        onClose();
        break;
    }
  }

  const style: CSSProperties = {
    left: placement.left,
    top: placement.top ?? "auto",
    bottom: placement.bottom ?? "auto",
    width: placement.width,
    maxHeight: placement.maxHeight,
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      id={id}
      className="o-popover"
      data-up={placement.up}
      style={style}
      onKeyDown={onKeyDown}
    >
      <div className="o-popover-scroll" role="none">
        {groups.map((group, groupIndex) => (
          <PopoverGroup
            // biome-ignore lint/suspicious/noArrayIndexKey: 群組沒有穩定的 id，順序固定
            key={groupIndex}
            group={group}
            separated={groupIndex > 0}
            selectable={selectable}
            onSelect={(item) => {
              if (item.disabled || item.fixed) return;
              onSelect(item.value);
              if (closeOnSelect) close();
            }}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}

function PopoverGroup<V>({
  group,
  separated,
  selectable,
  onSelect,
}: {
  group: MenuGroup<V>;
  separated: boolean;
  selectable: boolean;
  onSelect: (item: MenuItem<V>) => void;
}) {
  const titleId = useId();
  return (
    <>
      {separated && <hr className="o-popover-separator" />}
      {/* biome-ignore lint/a11y/useSemanticElements: menu 中的分組要用 role="group"，fieldset 不能放在 menu 裡 */}
      <div role="group" aria-labelledby={group.title ? titleId : undefined}>
        {group.title && (
          <div id={titleId} className="o-popover-group-title" data-mono={group.titleMono === true}>
            {group.logo && <span className="o-popover-logo">{group.logo}</span>}
            <span className="o-popover-group-name">
              <bdi>{group.title}</bdi>
            </span>
            {group.titleSub && <span className="o-popover-group-sub">{group.titleSub}</span>}
          </div>
        )}
        <FluidList className="o-popover-items" role="none">
          {group.items.map((item, itemIndex) => (
            <PopoverItem
              // biome-ignore lint/suspicious/noArrayIndexKey: value 可能不是字串
              key={itemIndex}
              item={item}
              indent={Boolean(group.title && group.logo)}
              selectable={selectable}
              onSelect={() => onSelect(item)}
            />
          ))}
        </FluidList>
      </div>
    </>
  );
}

function PopoverItem<V>({
  item,
  indent,
  selectable,
  onSelect,
}: {
  item: MenuItem<V>;
  indent: boolean;
  selectable: boolean;
  onSelect: () => void;
}) {
  const inactive = item.disabled === true || item.fixed !== undefined;
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role 是 menuitemradio 時才帶 aria-checked
    <button
      type="button"
      role={selectable ? "menuitemradio" : "menuitem"}
      aria-checked={selectable ? item.checked === true : undefined}
      aria-disabled={inactive || undefined}
      aria-label={item.ariaLabel}
      tabIndex={-1}
      className="o-popover-item"
      data-indent={indent}
      data-checked={item.checked === true}
      data-danger={item.danger === true}
      data-disabled={item.disabled === true}
      data-tip={item.disabled ? item.disabledReason : undefined}
      {...(inactive ? {} : fluidItem)}
      onClick={onSelect}
    >
      {item.icon && <span className="o-popover-icon">{item.icon}</span>}
      {item.tree && (
        <span className="o-popover-tree" aria-hidden="true">
          {item.tree}
        </span>
      )}
      <span className="o-popover-text">
        <span className="o-popover-label" data-mono={item.mono === true}>
          {item.label}
        </span>
        {item.sub && <span className="o-popover-sub">{item.sub}</span>}
      </span>
      {item.tag && <span className="o-popover-tag">{item.tag}</span>}
      {item.fixed && <span className="o-popover-tag">{item.fixed}</span>}
      {selectable && (
        <span className="o-popover-check" aria-hidden="true">
          <Check size={14} />
        </span>
      )}
    </button>
  );
}

/**
 * 觸發按鈕與 Popover 的開關狀態：
 * `<button ref={menu.anchorRef} {...menu.triggerProps}>` 搭配 `<Popover {...menu.popoverProps} …>`。
 */
export function useMenu<T extends HTMLElement = HTMLButtonElement>() {
  const anchorRef = useRef<T>(null);
  const [open, setOpen] = useState(false);
  const onClose = useCallback(() => setOpen(false), []);
  return {
    anchorRef,
    open,
    setOpen,
    close: onClose,
    triggerProps: {
      "aria-haspopup": "menu" as const,
      "aria-expanded": open,
      onClick: () => setOpen((value) => !value),
    },
    popoverProps: { anchorRef, open, onClose },
  };
}
