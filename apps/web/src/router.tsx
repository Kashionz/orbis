import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type ErrorComponentProps,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { AdminPage } from "./features/admin/AdminPage";
import { meQueryOptions, UnauthorizedError } from "./features/auth/api";
import { LoginPage } from "./features/auth/LoginPage";
import { BoardPage } from "./features/board/BoardPage";
import { DraftTasksPage } from "./features/draft-tasks/DraftTasksPage";
import { NeedsYouPage } from "./features/needs-you/NeedsYouPage";
import { NotificationSettingsPage } from "./features/notifications/NotificationSettingsPage";
import { NotificationsPage } from "./features/notifications/NotificationsPage";
import { ProjectSettingsPage } from "./features/project/ProjectSettingsPage";
import { RepoSpecPage } from "./features/repo-spec/RepoSpecPage";
import { RunReviewRoute, RunRoute, TaskWorkspaceRoute } from "./features/run/workspace-routes";
import { AppShell } from "./features/shell/AppShell";
import { parseRunLinkSearch, parseTaskWorkspaceSearch } from "./features/shell/workspace-search";
import { useT } from "./i18n";

// 元件展示頁只在 mock 模式註冊（元件的 Playwright 測試用），正式版不打包
const ComponentGallery =
  import.meta.env.MODE === "mock"
    ? lazy(() =>
        import("./dev/ComponentGallery").then((module) => ({ default: module.ComponentGallery })),
      )
    : null;

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/board" });
  },
});

/** 需要登入的路由都放在這個 layout 底下；未登入（401）一律導向登入頁。 */
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(meQueryOptions);
    } catch (error) {
      if (error instanceof UnauthorizedError) throw redirect({ to: "/login" });
      throw error;
    }
  },
  component: AppShell,
  errorComponent: AuthErrorPage,
});

const boardRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/board",
  validateSearch: (search: Record<string, unknown>): { project?: string } =>
    typeof search.project === "string" ? { project: search.project } : {},
  component: function BoardRouteComponent() {
    const { project } = boardRoute.useSearch();
    return <BoardPage projectId={project} />;
  },
  errorComponent: PageError,
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/$projectId/settings",
  component: function ProjectSettingsRouteComponent() {
    const { projectId } = projectSettingsRoute.useParams();
    return <ProjectSettingsPage key={projectId} projectId={projectId} />;
  },
  errorComponent: PageError,
});

const draftTasksRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/$projectId/draft-tasks",
  component: function DraftTasksRouteComponent() {
    const { projectId } = draftTasksRoute.useParams();
    return <DraftTasksPage key={projectId} projectId={projectId} />;
  },
  errorComponent: PageError,
});

const repoSpecRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/repo-specs/$repoSpecId",
  component: function RepoSpecRouteComponent() {
    const { repoSpecId } = repoSpecRoute.useParams();
    return <RepoSpecPage key={repoSpecId} repoSpecId={repoSpecId} />;
  },
  errorComponent: PageError,
});

/** Task 的工作區（README §2）：search 的 `run`、`tab`、`focus` 見 workspace-search.ts。 */
const taskRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/tasks/$taskKey",
  validateSearch: parseTaskWorkspaceSearch,
  component: function TaskRouteComponent() {
    const { taskKey } = taskRoute.useParams();
    const search = taskRoute.useSearch();
    return <TaskWorkspaceRoute key={taskKey} taskKey={taskKey} {...search} />;
  },
  errorComponent: PageError,
});

/**
 * 某個 Run 的深連結：Desktop 的桌面通知、Needs You 與通知中心都用這個網址（ARCHITECTURE §16.1）。
 * `focus`：要捲到的時間軸項目；`tab`：一開始顯示的分頁（`verification` 直接開 Verification 的決定）。
 */
const runRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/runs/$runId",
  validateSearch: parseRunLinkSearch,
  component: function RunRouteComponent() {
    const { runId } = runRoute.useParams();
    const search = runRoute.useSearch();
    return <RunRoute key={runId} runId={runId} {...search} />;
  },
  errorComponent: PageError,
});

const reviewRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/runs/$runId/review",
  component: function ReviewRouteComponent() {
    const { runId } = reviewRoute.useParams();
    return <RunReviewRoute key={runId} runId={runId} />;
  },
  errorComponent: PageError,
});

const needsYouRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/needs-you",
  component: NeedsYouPage,
  errorComponent: PageError,
});

const notificationsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/notifications",
  component: NotificationsPage,
  errorComponent: PageError,
});

const notificationSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings/notifications",
  component: NotificationSettingsPage,
  errorComponent: PageError,
});

const adminRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/admin",
  component: AdminPage,
  errorComponent: PageError,
});

const componentGalleryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__dev/components",
  component: function ComponentGalleryRoute() {
    if (!ComponentGallery) return <NotFoundPage />;
    return (
      <Suspense fallback={null}>
        <ComponentGallery />
      </Suspense>
    );
  },
});

function NotFoundPage() {
  const t = useT();
  return (
    <main className="notice">
      <h1>{t.common.notFound}</h1>
    </main>
  );
}

function AuthErrorPage({ error }: ErrorComponentProps) {
  const t = useT();
  return (
    <main className="notice" role="alert">
      <h1>{t.common.authLoadFailed}</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
    </main>
  );
}

function PageError({ error }: ErrorComponentProps) {
  const t = useT();
  return (
    <main className="notice" role="alert">
      <h1>{t.common.pageLoadFailed}</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
    </main>
  );
}

const routeTree = rootRoute.addChildren([
  loginRoute,
  indexRoute,
  ...(ComponentGallery ? [componentGalleryRoute] : []),
  authedRoute.addChildren([
    boardRoute,
    projectSettingsRoute,
    draftTasksRoute,
    repoSpecRoute,
    taskRoute,
    runRoute,
    reviewRoute,
    needsYouRoute,
    notificationsRoute,
    notificationSettingsRoute,
    adminRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient } });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
