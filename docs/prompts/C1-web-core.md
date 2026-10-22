# C1 Web Core（W2–4）

你是 Track C，在自己的 Orca Worktree 中開發 Orbis Web UI（React、Vite、TanStack）。目標是做出 M1 Dogfood 需要的畫面：看板、Task 頁、派工、Run 即時檢視、Needs You 清單、diff review。

## 先讀

- `CLAUDE.md`、`GLOSSARY.md`
- `docs/ARCHITECTURE.md` §4、§5、§8、§10、§12.2
- `packages/api-contract` 與 `packages/protocol` 的型別

## 範圍

你擁有 `apps/web`。B 軌的 API 還沒完成時，用 MSW 依照 `packages/api-contract` 模擬 API，並在程式碼中標註 `// TODO(api)`。

## 交付項目

1. **看板**：依 Project 分欄顯示 Task 的狀態；可以拖曳移動（只允許合法的狀態轉換）；用 Task Key 搜尋。
2. **Task 頁**：
   - 描述（這個階段用一般的 markdown 編輯器，C2 才換成 Yjs）。
   - Acceptance Criterion 清單，可以設定類型。
   - `depends_on`、指派對象。
   - Run 歷史。
3. **派工對話框**：選擇 Agent、在哪裡跑（我的電腦或 Team Runner）、Permission Policy。依 Role 和 AgentAvailability 顯示可用的選項。
4. **Run 即時檢視**：訂閱 Event 串流並即時渲染，包含訊息、思考（可以收合）、tool call（內含 diff 預覽）、權限請求（可以直接在列表中允許或拒絕）、用量、錯誤。重新整理頁面後從 seq 重播，畫面要完全一樣。
5. **Needs You 清單**：顯示所有等待自己處理的項目，一鍵跳到對應的位置。
6. **Diff review**：
   - 用 Monaco 顯示 diff，可以依檔案切換。
   - 可以在任一行加入留言。
   - 「退回並附上留言」把留言打包送出；「核准」觸發開 PR。
7. **依 Role 隱藏沒有權限的操作**（權限檢查仍以 Server 為準）。

## 完成條件

- 每個畫面都有 Playwright 測試，接上 Fake Agent 驅動的完整系統（或 MSW），涵蓋 M1 路徑：建立 Task → 派工 → 即時 Event → 回覆權限請求 → diff 留言退回 → 核准。
- Run 即時檢視可以順暢顯示 5,000 筆 Event（使用虛擬列表），並用測試驗證。
- 三平台 CI 全部通過。

## 結束時

開 PR `track-c: web core`，說明中列出還在使用 mock 的 API（`TODO(api)`）。
