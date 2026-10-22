import { NAMES } from "@orbis/api-contract";
import { GITHUB_LOGIN_PATH } from "./api";

export function LoginPage() {
  return (
    <main className="login">
      <h1>{NAMES.productName}</h1>
      {/* 交給 Server 走 GitHub OAuth，必須是整頁導向，不能用 Router 的 Link */}
      <a className="button" href={GITHUB_LOGIN_PATH}>
        使用 GitHub 登入
      </a>
    </main>
  );
}
