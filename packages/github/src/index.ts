// GitHub 整合（D 軌）：GitHub App、webhook、Issues 雙向同步、開 PR。
// Server 的用法見 README.md。

export { type InstallationToken, InstallationTokenCache } from "./auth/installation-tokens";
export { createHttpGitHubClient, GITHUB_API_URL } from "./client/http";
export * from "./client/types";
export {
  GITHUB_APP_ENV,
  type GitHubAppConfig,
  GitHubAppConfigError,
  loadGitHubAppConfig,
} from "./config";
export { appBotLogin } from "./context";
export {
  createGitHubIntegration,
  type GitHubIntegration,
  type GitHubIntegrationOptions,
} from "./integration";
export type { ImportableIssue, ImportResult } from "./issues/import";
export { RepoNotConnectedError } from "./issues/import";
export type { IssueEventOutcome, PushOutcome } from "./issues/sync";
export { PULL_REQUEST_MARKER, SUMMARY_MARKER } from "./markdown";
export * from "./ports";
export type { BranchPushed, OpenPullRequestResult, PullRequestEventOutcome } from "./pull-requests";
export { installUrl, type RepoInspection } from "./repos";
export { createGitHubWebhookRoutes } from "./routes";
export {
  DELIVERY_STALE_AFTER_MS,
  WEBHOOK_HANDLERS,
  type WebhookRequest,
  type WebhookResult,
} from "./webhook/handler";
export { signWebhookBody, verifyWebhookSignature } from "./webhook/verify";
