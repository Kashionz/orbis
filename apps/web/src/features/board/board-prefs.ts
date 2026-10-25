// 看板的篩選與檢視，存在 localStorage（個人偏好，不經過 Server）。

import { parseEnum, persistentState } from "../../lib/storage";
import { BOARD_FILTERS, BOARD_VIEWS, type BoardFilter, type BoardView } from "./board-model";

export const boardViewState = {
  filter: persistentState<BoardFilter>("board-filter", "all", parseEnum(BOARD_FILTERS)),
  view: persistentState<BoardView>("board-view", "list", parseEnum(BOARD_VIEWS)),
};
