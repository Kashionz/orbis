// Server↔Web 與 Desktop↔Server 共用的 REST／WebSocket 契約版本（ARCHITECTURE §16「版本相容」）。
// 不相容的變更（刪除或改變既有欄位的意義、改變路由）要遞增；只新增選填欄位不用。
// Server 由 `/api/health` 回報自己的版本，Web 與 Desktop 比對後提示要更新哪一個元件。
//
// - 1：Phase 1（W2–W9）。
// - 2：新工作區介面的後端缺口：Needs You 的 `stopped_run` 改成代碼、Repo 加 `kind`（本機 Repo）、
//   `CreateRepoInput` 改成以 `kind` 區分、`CreateTaskInput.repoId` 可以是 null，以及新的 API 與欄位。

export const API_VERSION = 2;
