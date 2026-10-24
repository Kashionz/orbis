// 需要登入的頁面外框（README Global Layout）：側欄＋主欄。路由的 beforeLoad 已經確保登入狀態在快取中。

import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/ErrorText";
import { useT } from "../../i18n";
import { meQueryOptions } from "../auth/api";
import { logout } from "../auth/logout";
import { VersionBanner } from "../version/VersionBanner";
import { Sidebar } from "./Sidebar";
import { ShellProvider } from "./shell-context";
import "./shell.css";

export function AppShell() {
  const { data: me } = useSuspenseQuery(meQueryOptions);
  if (!me.member) return <NotMember login={me.githubLogin} />;
  return (
    <ShellProvider>
      <div className="shell">
        <Sidebar />
        <div className="shell-main">
          <VersionBanner />
          <div className="shell-outlet">
            <Outlet />
          </div>
        </div>
      </div>
    </ShellProvider>
  );
}

/** 已登入但還不是任何 Team 的 Member。 */
function NotMember({ login }: { login: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation({
    mutationFn: () => logout(),
    onSuccess: async (loggedOut) => {
      if (!loggedOut) return;
      queryClient.clear();
      await navigate({ to: "/login" });
    },
  });
  return (
    <main className="notice">
      <h1>{t.shell.notMemberTitle}</h1>
      <p>{t.shell.notMemberBody(login)}</p>
      <Button disabled={signOut.isPending} onClick={() => signOut.mutate()}>
        {t.shell.signOut}
      </Button>
      <ErrorText error={signOut.error} />
    </main>
  );
}
