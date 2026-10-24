// 版面骨架、側欄、個人選單。

export default {
  mainNav: "主要導覽",
  searchPlaceholder: "搜尋任務",
  searchLabel: "搜尋任務",
  board: "看板",
  needsYou: "待我處理",
  notifications: "通知",
  needsYouCount: (n: number) => `${n} 個待處理項目`,
  unreadCount: (n: number) => `${n} 則未讀`,
  sections: {
    active: "進行中",
    pr: "合併請求",
    ready: "就緒",
    backlog: "待辦",
    done: "完成",
  },
  noMatchingTasks: "沒有符合的任務",
  resizeSidebar: "調整側欄寬度",
  resizePanel: "調整面板寬度",
  showPanel: "顯示面板",
  hidePanel: "隱藏面板",

  profileMenu: "個人選單",
  settings: "設定",
  runners: "執行器",
  admin: "管理",
  signOut: "登出",
  noLocalRunner: "尚未配對",

  notMemberTitle: "尚未加入團隊",
  notMemberBody: (login: string) => `已用 GitHub 帳號 ${login} 登入，但還不是任何團隊的成員。`,
  noProjects: "還沒有任何專案",
};
