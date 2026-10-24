# Orbis

給小團隊用的專案管理加 Agent Workspace。Task 派給 coding agent 執行，從 Spec 到 PR merge 都在同一處完成。

## 先讀

- **名詞**：[GLOSSARY.md](GLOSSARY.md)。程式碼、UI 文字、commit 訊息一律使用其中的標準名詞，不使用 `_Avoid_` 列出的同義詞。
- **設計**：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 是唯一依據，只讀和你這次工作相關的章節。
- **為什麼這樣設計**：[docs/adr/](docs/adr/)。想推翻某項設計之前，先讀對應的 ADR，然後提出來討論，不要直接改。
- **分軌與目錄所有權**：[docs/PLAN.md](docs/PLAN.md)。

## 工作規則

- **只修改你這條軌擁有的目錄**（見 PLAN.md）。契約目錄要依照 PLAN.md 的「契約變更流程」修改。
- `packages/protocol` 由 `crates/orbis-protocol` 透過 `ts-rs` 產生，要改型別就改 Rust，再重新產生。
- **測試用 Fake Agent**（`crates/fake-agent`），不呼叫真實模型。新的 Agent 行為先寫成劇本，再寫程式碼。
- **Windows 是主要平台**：
  - 路徑一律經過正規化函式處理。
  - spawn 子程序時自己處理引號。
  - 產生 shell 指令時要考慮 `cmd`、PowerShell、Git Bash 三種環境。
- 產品名稱、設定檔名、環境變數前綴只能從名稱常數取得，不可以寫死字串。

## 完成的定義

- Windows、macOS 兩個平台的 CI 全部通過（Linux 目前不在 CI 驗證，但程式中的 Linux 路徑要保留）。
- 新的行為都有測試：Runner 用真實 git 加上 Fake Agent，Server 用 Testcontainers 的 Postgres，UI 用 Playwright。
- 改到 ARCHITECTURE 描述的行為時，同一個 PR 內要一併更新 ARCHITECTURE。
- 出現新名詞時，同一個 PR 內要一併更新 GLOSSARY。
