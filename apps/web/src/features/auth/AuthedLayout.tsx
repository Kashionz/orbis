import { NAMES } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { needsYouQuery, notificationsUnreadCountQuery } from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { ROLE_LABELS } from "../../lib/labels";
import { useNotificationStream } from "../notifications/use-notification-stream";
import { VersionBanner } from "../version/VersionBanner";
import { meQueryOptions } from "./api";
import { logout } from "./logout";

/** 需要登入的頁面外框。路由的 beforeLoad 已經確保登入狀態在快取中。 */
export function AuthedLayout() {
  const { data: me } = useSuspenseQuery(meQueryOptions);

  return (
    <div className="app">
      <header className="app-header">
        <span className="product-name">{NAMES.productName}</span>
        {me.member && <span className="team-name">{me.member.teamName}</span>}
        {me.member && (
          <nav className="app-nav" aria-label="主要導覽">
            <Link to="/board" activeProps={{ "aria-current": "page" }}>
              看板
            </Link>
            <NeedsYouLink />
            <NotificationsLink />
            {me.member.role !== "viewer" && (
              <Link to="/admin" activeProps={{ "aria-current": "page" }}>
                管理
              </Link>
            )}
          </nav>
        )}
        <span className="spacer" />
        {me.avatarUrl && <img className="avatar" src={me.avatarUrl} alt="" />}
        <span>{me.githubLogin}</span>
        {me.member && <span className="role-badge">{ROLE_LABELS[me.member.role]}</span>}
        <LogoutButton />
      </header>
      <VersionBanner />
      {me.member ? (
        <Outlet />
      ) : (
        <main className="notice">
          <h1>尚未加入 Team</h1>
          <p>你已經以 GitHub 帳號 {me.githubLogin} 登入，但還不是任何 Team 的 Member。</p>
        </main>
      )}
    </div>
  );
}

function NeedsYouLink() {
  const { data } = useQuery(needsYouQuery);
  const count = data?.length ?? 0;
  return (
    <Link to="/needs-you" activeProps={{ "aria-current": "page" }}>
      Needs You
      {count > 0 && (
        <span className="count-badge" data-testid="needs-you-count">
          {count}
          <span className="visually-hidden"> 個項目</span>
        </span>
      )}
    </Link>
  );
}

/** 通知中心的入口與未讀數；`notification` 推送常駐監聽，收到時即時更新。 */
function NotificationsLink() {
  useNotificationStream();
  const { data } = useQuery(notificationsUnreadCountQuery);
  const count = data?.count ?? 0;
  return (
    <Link to="/notifications" activeProps={{ "aria-current": "page" }}>
      通知
      {count > 0 && (
        <span className="count-badge" data-testid="notification-count">
          {count}
          <span className="visually-hidden"> 則未讀</span>
        </span>
      )}
    </Link>
  );
}

function LogoutButton() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: () => logout(),
    onSuccess: async (loggedOut) => {
      if (!loggedOut) return;
      queryClient.clear();
      await navigate({ to: "/login" });
    },
  });
  return (
    <>
      <button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        登出
      </button>
      <ErrorText error={mutation.error} />
    </>
  );
}
