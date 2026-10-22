import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type ErrorComponentProps,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AuthedLayout } from "./features/auth/AuthedLayout";
import { meQueryOptions, UnauthorizedError } from "./features/auth/api";
import { LoginPage } from "./features/auth/LoginPage";
import { BoardPage } from "./features/board/BoardPage";

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
  component: BoardPage,
});

function AuthErrorPage({ error }: ErrorComponentProps) {
  return (
    <main className="notice" role="alert">
      <h1>無法取得登入狀態</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
    </main>
  );
}

const routeTree = rootRoute.addChildren([
  loginRoute,
  indexRoute,
  authedRoute.addChildren([boardRoute]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient } });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
