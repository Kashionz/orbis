# 90 Integration：M1 Dogfood（W4 末）

你負責把 A1–E1 的成果整合起來，達成 **M1 Dogfood**。從這之後，Orbis 自己的開發都改用 Orbis 進行。

## 先讀

- `CLAUDE.md`、`docs/PLAN.md` 的里程碑
- 各軌 PR 說明中的介面清單、`TODO(api)`、`TODO(contract)`

## 交付項目

1. 確認 A1–E1 都已合併到 `main`，並清除所有的 `TODO(api)` 與 `TODO(contract)`：每一個都要接上真實的實作，或改成有對應 issue 的明確待辦。
2. 寫一個**端到端測試**，以 Fake Agent 驅動：Server、Local Runner、Web UI 都是真實的元件，在 Electron 中走完 M1 的完整路徑（見 PLAN.md 的 M1 完成條件）。
3. 在 **Windows 實機**上用真實的 Claude Code 手動走完 M1 路徑，記錄每一個卡住或不順的地方，並修正會阻擋使用的問題。
4. **Dogfood 設定**：
   - 在 Orbis 中建立 Project `Orbis`（Task Key 前綴 `ORB`），登記 Orbis 自己的 repo。
   - 為 Orbis repo 寫好 `.orbis/config.toml`。
   - 把 `docs/prompts/A2`–`E2` 拆成 Task，每個 Task 都要有 Acceptance Criterion，以 `command` 類型為主。

## 完成條件（M1）

- 端到端測試在 CI 的三平台全部通過。
- 在 Windows 實機上，至少有一個 Orbis 自己的 Task 是由 Claude Code 透過 Orbis 完成、開 PR、merge，最後自動轉成 Done。
- 第 3 項記錄到的問題都已經修正，或已建立成 Orbis 中的 Task。

## 結束時

開 PR `integration: m1 dogfood`，在說明中附上實機操作的紀錄，並打上 tag `m1`。
