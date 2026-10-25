// 設定對話框（README §9）。

export default {
  title: "設定",
  nav: {
    general: "一般",
    runners: "執行器",
    agents: "代理",
    notifications: "通知",
    account: "帳號",
  },
  theme: "主題",
  themes: {
    dark: "深色",
    light: "淺色",
    system: "跟隨系統",
  },
  language: "語言",
  languages: {
    "zh-TW": "中文",
    en: "English",
  },
  defaultLayout: "預設版面",
  layouts: {
    split: "分割",
    stream: "僅串流",
  },
  autoExpandTools: "自動展開工具步驟",
  version: "版本",
  versionDesktop: (version: string) => `Desktop ${version}`,
  versionServer: (version: string) => `伺服器 ${version}`,

  noRunners: "還沒有任何執行器完成配對",
  runnerOnline: "已連線",
  runnerPaused: "暫停領取",
  runnerOffline: "離線",
  defaultShell: "預設終端",
  windowsLongPaths: "Windows 長路徑",
  pairRunner: "配對新的執行器",
  pairLocal: "本機執行器",
  pairLocalSub: "在自己的電腦上執行",
  pairTeam: "團隊執行器",
  pairTeamSub: "在團隊共用的主機上執行",
  pairingToken: "配對碼",
  pairingTokenExpires: (time: string) => `${time} 前有效，只顯示這一次`,
  pairingTokenEnv: (tokenEnv: string, urlEnv: string) =>
    `設定環境變數 ${tokenEnv} 與 ${urlEnv} 後啟動執行器`,

  noAgents: "還沒有可用的代理",
  signedIn: "已登入",
  needsSignIn: "需要重新登入",
  signIn: "重新登入",
  signingIn: (tool: string) => `正在開啟 ${tool} 登入`,
  defaultModel: "預設模型",
  defaultModelOf: (tool: string) => `${tool} 的預設模型`,
  agentDefault: "代理預設",

  desktopNotifications: "桌面通知",
  quietHours: "勿擾時段",
  quietHoursFrom: "開始",
  quietHoursTo: "結束",
  timeZone: "時區",
  saved: "已儲存",

  teamName: "團隊名稱",
  members: "成員",
  memberCount: (n: number) => `${n} 成員`,
  manageMembers: "管理",
};
