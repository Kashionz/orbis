// 邀請連結失敗時的頁面（`PAGE_ROUTES.inviteError`，查詢參數 `code` 是 INVITE_ERROR_CODES 之一）：
// Task 邀請與預覽邀請共用。Server 的邀請連結（`/invites/<token>`、`/preview-invites/<token>`）轉到這裡。

import { NAMES } from "@orbis/api-contract";
import { useT } from "../../i18n";
import { GITHUB_LOGIN_PATH } from "./api";

export function InviteErrorPage({ code }: { code: string | undefined }) {
  const t = useT();
  const e = t.auth.inviteError;
  const message =
    code === "invite_not_found" ||
    code === "invite_expired" ||
    code === "invite_revoked" ||
    code === "invite_email_mismatch"
      ? e[code]
      : e.unknown;
  return (
    <main className="login" data-testid="invite-error" data-code={code}>
      <h1>{NAMES.productName}</h1>
      <p role="alert">{message}</p>
      {code === "invite_email_mismatch" && (
        // 用其他 GitHub 帳號重新登入
        <a className="button" href={GITHUB_LOGIN_PATH}>
          {e.switchAccount}
        </a>
      )}
    </main>
  );
}
