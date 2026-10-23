// GitHub App manifest（https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest）。
// 產品名稱從名稱常數取得，所以 manifest 由程式產生，不放靜態的 JSON 檔。

import { NAMES } from "@orbis/api-contract";

/** App 需要的權限。 */
export const APP_PERMISSIONS = {
  /** Issues 雙向同步、狀態摘要留言。 */
  issues: "write",
  /** 開 PR、讀取 review（D2 Feedback Loop）。 */
  pull_requests: "write",
  /** Team Runner 以 installation token push 分支；D2 的「提交 Spec 到 repo」。 */
  contents: "write",
  /** D2：讀取 CI 結果。 */
  checks: "read",
  /** D2：讀取 GitHub Actions 的 job log，擷取 CI 失敗的段落給 Feedback Loop。 */
  actions: "read",
  /** 所有 App 都需要。 */
  metadata: "read",
} as const;

/**
 * 訂閱的 webhook 事件。`installation`、`installation_repositories` 不需要訂閱，App 一律會收到。
 * `pull_request_review`、`pull_request_review_comment`、`check_suite`、`check_run` 由 D2 處理，先訂閱好，
 * 免得之後每個安裝都要重新核准權限。
 */
export const APP_EVENTS = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "check_suite",
  "check_run",
] as const;

/** App 一律會收到、不需要（也不能）在 manifest 訂閱的事件。 */
export const ALWAYS_DELIVERED_EVENTS = ["installation", "installation_repositories"] as const;

export interface AppManifestOptions {
  /** App 名稱，GitHub 上全域唯一，例如 `<產品名稱> (acme)`。 */
  name?: string;
  /** Server 對外的網址，例如 `https://pm.example.com`。 */
  publicUrl: string;
  /** webhook 的網址；預設是 `<publicUrl>/api/webhooks/github`。開發時可以指向 smee.io。 */
  webhookUrl?: string;
  /** manifest 流程完成後 GitHub 導回的網址（帶 `code`）。 */
  redirectUrl: string;
}

export function appManifest(options: AppManifestOptions) {
  const publicUrl = options.publicUrl.replace(/\/+$/, "");
  return {
    name: options.name ?? NAMES.productName,
    url: publicUrl,
    description: `${NAMES.productName}：Task 與 GitHub Issues 雙向同步、Review Gate 核准後開 PR。`,
    hook_attributes: {
      url: options.webhookUrl ?? `${publicUrl}/api/webhooks/github`,
      active: true,
    },
    redirect_url: options.redirectUrl,
    public: false,
    default_permissions: { ...APP_PERMISSIONS },
    default_events: [...APP_EVENTS],
  };
}
