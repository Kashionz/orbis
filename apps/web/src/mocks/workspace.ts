// 工作區後端缺口的 MSW handler（U2）：路徑是 features 目錄中的暫定路徑，不是契約。
// 真實模式下這些功能由 feature flag 關閉，見 `TODO(backend, …)`。

import { http } from "msw";
import { BOARD_SUMMARY_ROUTE } from "../features/board/types";
import { DRAFT_ROUTES, RunPromptInput, UpdateRunSettingsInput } from "../features/run/types";
import type { MockBackend } from "./backend";
import { handle, parse } from "./handlers";

export function createWorkspaceHandlers(backend: MockBackend) {
  return [
    http.post(
      DRAFT_ROUTES.runPrompts,
      handle(async (request, p) => {
        backend.submitPrompt(p.runId ?? "", (await parse(request, RunPromptInput)).text);
      }),
    ),
    http.get(
      DRAFT_ROUTES.runSettings,
      handle((_, p) => backend.runSettings(p.runId ?? "")),
    ),
    http.patch(
      DRAFT_ROUTES.runSettings,
      handle(async (request, p) =>
        backend.updateRunSettings(p.runId ?? "", await parse(request, UpdateRunSettingsInput)),
      ),
    ),
    http.get(
      DRAFT_ROUTES.runEventActors,
      handle((_, p) => backend.eventActors(p.runId ?? "")),
    ),
    http.get(
      DRAFT_ROUTES.taskPullRequest,
      handle((_, p) => backend.taskPullRequest(p.taskId ?? "")),
    ),
    http.get(
      BOARD_SUMMARY_ROUTE,
      handle((_, p) => backend.boardSummary(p.projectId ?? "")),
    ),
  ];
}
