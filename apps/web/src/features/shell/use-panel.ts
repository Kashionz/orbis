// 工作區右側面板的開關與寬度（README Global Layout）：寬度是容器的 26%–62%，預設 42%；
// 開關的預設值取自設定的「預設版面」，之後各自切換。兩者都存 localStorage。

import { layoutPreference } from "../../lib/preferences";
import {
  parseBoolean,
  parseNumberIn,
  persistentState,
  usePersistentState,
} from "../../lib/storage";

export const PANEL_SPLIT_MIN = 0.26;
export const PANEL_SPLIT_MAX = 0.62;
export const PANEL_SPLIT_DEFAULT = 0.42;
/** 方向鍵每次調整 2%。 */
export const PANEL_SPLIT_STEP = 0.02;

export const panelSplitState = persistentState<number>(
  "split",
  PANEL_SPLIT_DEFAULT,
  parseNumberIn(PANEL_SPLIT_MIN, PANEL_SPLIT_MAX),
);

/** 使用者手動切換過的開關；沒有切換過時為 null，跟著「預設版面」。 */
const panelOpenState = persistentState<boolean | null>("panel-open", null, parseBoolean, (value) =>
  String(value),
);

export interface PanelState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** 面板寬度佔工作區的比例（0.26–0.62）。 */
  split: number;
  setSplit: (split: number) => void;
  resetSplit: () => void;
}

export function usePanel(): PanelState {
  const [layout] = usePersistentState(layoutPreference);
  const [override, setOverride] = usePersistentState(panelOpenState);
  const [split, setSplit] = usePersistentState(panelSplitState);
  const open = override ?? layout === "split";
  return {
    open,
    setOpen: (value) => setOverride(value),
    toggle: () => setOverride(!open),
    split,
    setSplit,
    resetSplit: () => setSplit(PANEL_SPLIT_DEFAULT),
  };
}

/** 改了「預設版面」時，清掉手動切換的狀態，讓開關回到新的預設。 */
export function resetPanelOpenOverride(): void {
  panelOpenState.set(null);
}
