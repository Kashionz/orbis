// Server 與 Web 版本不相容的提示（ARCHITECTURE §16「版本相容」）。

export default {
  reload: "重新整理",
  reloadMessage: (serverApi: number, localApi: number) =>
    `介面有新版本，請重新整理（伺服器的 API 版本 ${serverApi}，目前載入的是 ${localApi}）`,
  updateServerMessage: (server: string, serverApi: number, localApi: number) =>
    `伺服器版本過舊，請更新伺服器（伺服器 v${server} 的 API 版本 ${serverApi}，介面需要 ${localApi}）`,
  noVersionsMessage: "伺服器版本過舊，請更新伺服器（伺服器沒有回報版本）",
};
