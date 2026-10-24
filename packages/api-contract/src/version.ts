// Server↔Web 與 Desktop↔Server 共用的 REST／WebSocket 契約版本（ARCHITECTURE §16「版本相容」）。
// 不相容的變更（刪除或改變既有欄位的意義、改變路由）要遞增；只新增選填欄位不用。
// Server 由 `/api/health` 回報自己的版本，Web 與 Desktop 比對後提示要更新哪一個元件。
//
// - 1：Phase 1（v0.1.0）。

export const API_VERSION = 1;
