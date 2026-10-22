import { NAMES } from "@orbis/api-contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Outlet } from "@tanstack/react-router";
import { meQueryOptions } from "./api";

/** 需要登入的頁面外框。路由的 beforeLoad 已經確保登入狀態在快取中。 */
export function AuthedLayout() {
  const { data: me } = useSuspenseQuery(meQueryOptions);

  return (
    <div className="app">
      <header className="app-header">
        <span className="product-name">{NAMES.productName}</span>
        {me.member && <span className="team-name">{me.member.teamName}</span>}
        <span className="spacer" />
        {me.avatarUrl && <img className="avatar" src={me.avatarUrl} alt="" />}
        <span>{me.githubLogin}</span>
      </header>
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
