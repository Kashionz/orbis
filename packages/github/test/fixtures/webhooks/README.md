# webhook payload fixture

檔名是 `<event>.<action>.json`。

- **從測試 repo 錄製的真實 payload**：`issues.*`（`transferred` 除外）、`issue_comment.*`、`pull_request.*`、`installation.created`、`ping`。手動驗證走過一輪之後，用 `pnpm --filter @orbis/github fixtures:record` 重新錄製，每種 event／action 取最新的一筆。
- **來自 [`@octokit/webhooks-examples`](https://github.com/octokit/webhooks/tree/main/payload-examples) 7.6.1**：`issues.transferred`、`installation.deleted`、`installation.suspend`、`installation.unsuspend`、`installation_repositories.*`。這些事件要另一個 repo，或要在 GitHub 上停用、移除 App 才會產生，手動驗證時沒有觸發。

錄製的 payload 中，webhook secret 會被 GitHub 遮蔽成 `********`；裡面沒有 token。
