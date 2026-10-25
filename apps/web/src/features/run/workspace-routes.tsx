// 工作區路由渲染的頁面（U2 負責內容，router.tsx 只呼叫這裡）。
// 新工作區完成前先沿用既有的 Task 頁、Run 頁與 diff review 頁。

import { lazy, Suspense } from "react";
import { useT } from "../../i18n";
import type { RunLinkSearch, TaskWorkspaceSearch } from "../shell/workspace-search";
import { TaskPage } from "../task/TaskPage";
import { RunPage, type RunTab } from "./RunPage";

// Monaco 很大，只在進入 diff review 時才載入
const ReviewPage = lazy(() =>
  import("../review/ReviewPage").then((module) => ({ default: module.ReviewPage })),
);

/** `/tasks/$taskKey`：Task 的工作區。 */
export function TaskWorkspaceRoute({ taskKey }: { taskKey: string } & TaskWorkspaceSearch) {
  return <TaskPage key={taskKey} taskKey={taskKey} />;
}

/** `/runs/$runId`：深連結（Desktop 桌面通知、Needs You、通知中心）開啟某個 Run。 */
export function RunRoute({ runId, focus, tab }: { runId: string } & RunLinkSearch) {
  const initialTab: RunTab | undefined =
    tab === "verification" || tab === "preview" || tab === "timeline" ? tab : undefined;
  return <RunPage key={runId} runId={runId} focus={focus} initialTab={initialTab} />;
}

/** `/runs/$runId/review`：Review Gate 的 diff。 */
export function RunReviewRoute({ runId }: { runId: string }) {
  const t = useT();
  return (
    <Suspense fallback={<main className="notice">{t.common.loading}</main>}>
      <ReviewPage key={runId} runId={runId} />
    </Suspense>
  );
}
