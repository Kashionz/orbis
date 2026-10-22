# 開發 Prompts

每個檔案是一段可以直接貼給 Claude Code 的 prompt，對應 [PLAN.md](../PLAN.md) 中的一個階段。

## 使用方式（Orca 多 Worktree）

1. **W1**：在主 checkout（或單一個 Orca Worktree）執行 `00-foundation.md`，合併後打上 tag `m0`。
2. **W2–4**：在 Orca 中從 `main` 開出 5 個 Worktree，分支名稱用 `track/a1-runner-core` 這種格式，每個 Worktree 啟動一個 Claude Code，各貼上 `A1`–`E1`。
3. 每個 Claude Code 先用 **plan mode** 提出計畫，你核准後它才開始實作。
4. 各軌完成後各自開 PR。**依序 review 並合併**，契約 PR 優先。
5. **W4 末**：執行 `90-integration-dogfood.md`。從這之後的工作都改成在 Orbis 裡建立 Task，W5–7 的 `A2`–`E2` 可以直接當作 Task 的 Spec。
6. **W8–9**：執行 `91-integration-release.md`。

Orca 的 `orca.yaml` 建議設定 `scripts.setup: pnpm install && cargo fetch`。這樣每個 Worktree 建好後依賴就裝好了。

## 檔案

| 檔案 | 週 | 內容 |
|---|---|---|
| [00-foundation](00-foundation.md) | W1 | monorepo、契約、Fake Agent、各元件骨架、CI |
| [A1-runner-core](A1-runner-core.md) | W2–4 | Worktree、ACP 接 Claude Code、Permission Policy、Event 串流 |
| [B1-server-core](B1-server-core.md) | W2–4 | API、狀態機、Dispatch、Event 儲存、Role |
| [C1-web-core](C1-web-core.md) | W2–4 | 看板、Task 頁、Run 即時檢視、diff review、Needs You |
| [D1-github-core](D1-github-core.md) | W2–4 | GitHub App、Issues 雙向同步、開 PR、merge 後轉 Done |
| [E1-desktop-core](E1-desktop-core.md) | W2–4 | Electron 殼、Runner sidecar、桌面通知 |
| [90-integration-dogfood](90-integration-dogfood.md) | W4 末 | 整合，達成 M1 |
| [A2-runner-advanced](A2-runner-advanced.md) | W5–7 | 其他 Agent、Planning、Verification、Delegation、MCP |
| [B2-server-advanced](B2-server-advanced.md) | W5–7 | Gate、重試、Child Run、通知、@mention、Yjs、並行控管 |
| [C2-web-advanced](C2-web-advanced.md) | W5–7 | 共同編輯、Plan Gate、Verification 結果、Child Run 樹、通知中心 |
| [D2-github-feedback](D2-github-feedback.md) | W5–7 | Feedback Loop、Spec 提交到 repo |
| [E2-preview](E2-preview.md) | W5–7 | Preview 轉送、內嵌瀏覽器、在 Preview 上留言 |
| [91-integration-release](91-integration-release.md) | W8–9 | 整合、Windows 強化、部署、發布，達成 M3 |
