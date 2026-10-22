# 自建 Task 模型，只與 GitHub Issues 雙向同步，不串 GitHub Projects

Task 需要 Agent 專用的結構化欄位（Spec、Acceptance Criterion、Run 歷史、Gate 狀態），而 GitHub Issues、Linear、Jira 都放不下這些。因此 Task 的唯一資料來源是 Orbis 自己的 Postgres。與 GitHub Issues 雙向同步的欄位只有 title、body、state、assignee、labels，衝突時以最後寫入者為準；Agent 專用的欄位只在 Issue 上以一則持續更新的摘要留言呈現。團隊目前沒有在用 GitHub Projects，所以不串。

## Considered Options

- **以 GitHub Issues 或 Linear 作為資料來源**：省下 CRUD 與看板，但 Agent 需要的欄位無處可放，而且雙向同步自訂欄位的成本很高。
