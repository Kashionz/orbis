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
import { AuthedLayout } from "./features/auth/AuthedLayout";
import { meQueryOptions, UnauthorizedError } from "./features/auth/api";
import { LoginPage } from "./features/auth/LoginPage";
import { BoardPage } from "./features/board/BoardPage";
import { DraftTasksPage } from "./features/draft-tasks/DraftTasksPage";
import { NeedsYouPage } from "./features/needs-you/NeedsYouPage";
import { NotificationSettingsPage } from "./features/notifications/NotificationSettingsPage";
import { NotificationsPage } from "./features/notifications/NotificationsPage";
import { ProjectSettingsPage } from "./features/project/ProjectSettingsPage";
import { RepoSpecPage } from "./features/repo-spec/RepoSpecPage";
import { RunPage } from "./features/run/RunPage";
import { TaskPage } from "./features/task/TaskPage";

// Monaco 很大，只在進入 diff review 時才載入
const ReviewPage = lazy(() =>
  import("./features/review/ReviewPage").then((module) => ({ default: module.ReviewPage })),
);

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: () => (
    <main className="notice">
      <h1>找不到這個頁面</h1>
    </main>
  ),
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
  component: AuthedLayout,
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

const taskRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/tasks/$taskKey",
  component: function TaskRouteComponent() {
    const { taskKey } = taskRoute.useParams();
    return <TaskPage key={taskKey} taskKey={taskKey} />;
  },
  errorComponent: PageError,
});

const runRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/runs/$runId",
  validateSearch: (search: Record<string, unknown>): { focus?: string } =>
    typeof search.focus === "string" ? { focus: search.focus } : {},
  component: function RunRouteComponent() {
    const { runId } = runRoute.useParams();
    const { focus } = runRoute.useSearch();
    return <RunPage key={runId} runId={runId} focus={focus} />;
  },
  errorComponent: PageError,
});

const reviewRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/runs/$runId/review",
  component: function ReviewRouteComponent() {
    const { runId } = reviewRoute.useParams();
    return (
      <Suspense fallback={<main className="notice">正在載入 diff review…</main>}>
        <ReviewPage key={runId} runId={runId} />
      </Suspense>
    );
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

function AuthErrorPage({ error }: ErrorComponentProps) {
  return (
    <main className="notice" role="alert">
      <h1>無法取得登入狀態</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
    </main>
  );
}

function PageError({ error }: ErrorComponentProps) {
  return (
    <main className="notice" role="alert">
      <h1>無法載入這個頁面</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
    </main>
  );
}

const routeTree = rootRoute.addChildren([
  loginRoute,
  indexRoute,
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
