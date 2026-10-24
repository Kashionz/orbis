// 各處共用的文字：動作、相對時間、時長、狀態。

export default {
  close: "關閉",
  cancel: "取消",
  save: "儲存",
  saving: "儲存中",
  create: "建立",
  delete: "刪除",
  remove: "移除",
  edit: "編輯",
  copy: "複製",
  copied: "已複製",
  retry: "重試",
  loading: "載入中",
  none: "無",
  unassigned: "未指派",
  notSpecified: "尚未指定",
  more: (n: number) => `還有 ${n} 項`,
  /** 後端還沒有的功能（lib/features.ts 關閉時）的 Tooltip。 */
  notAvailableYet: "尚未開放",
  online: "已連線",
  offline: "離線",
  connecting: "連線中",

  justNow: "剛剛",
  minutesAgo: (n: number) => `${n} 分鐘前`,
  hoursAgo: (n: number) => `${n} 小時前`,
  daysAgo: (n: number) => `${n} 天前`,
  /** 時長，例如「3m 12s」。 */
  durationSeconds: (s: number) => `${s}s`,
  durationMinutes: (m: number, s: number) => `${m}m ${s}s`,
  durationHours: (h: number, m: number) => `${h}h ${m}m`,

  notFound: "找不到這個頁面",
  pageLoadFailed: "無法載入這個頁面",
  authLoadFailed: "無法取得登入狀態",
  requestFailed: (status: number) => `請求失敗（HTTP ${status}）`,
  unknownError: "發生錯誤",
  signedOut: "尚未登入",
  forbidden: (message: string) => `沒有權限：${message}`,
  notReadyMissing: (missing: string) => `還不能進入就緒，缺少：${missing}`,
  listSeparator: "、",
};
