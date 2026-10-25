# 本機 Repo：不經過 GitHub 也能走完整個流程，之後可以單向連接到 GitHub

沒有 GitHub App（或還不想把專案放上 GitHub）時，原本建立 Repo、派工、Run、審查關卡、push 都能用，但 Task 到不了 Done，因為 Done 只靠 PR merge 的 webhook。我們加一種 Repo：本機 Repo（`kind = local`），只有名稱，路徑沿用各 Runner 的 `runner.toml` 對應（`[repos.<名稱>]`），Server 不保存路徑、不檢查 GitHub 的命名規則。

本機 Repo 只能派到 `runner.toml` 有對應這個 Repo 的 Local Runner（Runner 在 AgentAvailability 回報對應的 key），Team Runner 不能選。核准之後由 Runner 把 Run 的分支合併到本機 checkout 的基準分支（RunControl `merge_local`），Task 直接轉 Done 並封存 Worktree：

- 基準分支沒有簽出：在暫時的 worktree 中合併；已簽出且工作目錄乾淨：直接在 checkout 中合併。
- 工作目錄有未 commit 的變更或合併衝突：不合併，Run 停下（`local_merge_blocked`），放進待我處理，處理後重試。
- 合併方式是 Project 設定（squash，或 merge commit）；checkout 有 `origin` 時可以選擇合併後 push 基準分支（預設關閉）。
- Repo Spec 改成直接 commit 到基準分支，走同一套規則，經由提交者自己有對應的 Local Runner 執行（frame `repo_spec_commit`），版本在 commit 時加 1。

本機 Repo 不提供 Issues 同步與 Feedback Loop；Verification 與預覽照常運作。登入仍用 GitHub OAuth，只用來確認身分。

**連接到 GitHub**：Project 設定中填 owner 與 name，Server 確認 GitHub App 已安裝在那個 repo 上之後，`kind` 改成 `github`，只能單向。前置條件是本機 checkout 的 `origin` 指向那個 repo 而且基準分支已 push；Orbis 不幫忙建立 GitHub repo，畫面只顯示可以照著執行的指令（例如 `gh repo create <name> --source . --push`）。之後新的 Run 核准後走 push 與開 PR，Issues 同步、Feedback Loop、Repo Spec 的 PR 從此啟用；連接時停在審查關卡的 Run，核准時依新的 `kind` 開 PR。

## Considered Options

- **另做一套不用 GitHub 的登入**：範圍太大，而且團隊都有 GitHub 帳號；這次只做 Repo 這一層。
- **Server 保存本機路徑**：同一個 Repo 在每個人的電腦上路徑不同，而且路徑屬於那台電腦，所以沿用 `runner.toml`。
- **由 Orbis 代為建立 GitHub repo**：需要個人帳號的 `repo` scope，權限太大，所以只顯示指令。

## Consequences

- `DispatchOffer` 的 repo 改成以 `kind` 區分（本機 Repo 沒有 clone URL），協定版本因此遞增。
- Repo 的唯一性分成兩種：GitHub Repo 是 (Project, owner, name)，本機 Repo 是 (Project, name)。
- Task 狀態機多一條 `review_gate → done`（本機合併）。
