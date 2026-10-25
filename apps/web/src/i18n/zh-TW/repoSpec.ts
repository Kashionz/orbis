// 儲存庫規格：專案設定頁的清單與登記、草稿頁。

export default {
  section: "儲存庫規格",
  sectionHint:
    "儲存庫中的 markdown 規格，在介面中共同編輯草稿，按下「提交到儲存庫」後開啟合併請求。",
  noSpecs: "還沒有登記規格。",
  version: (n: number) => `第 ${n} 版`,
  openPullRequest: (n: number) => `合併請求 #${n} 未合併`,
  registerForm: (repo: string) => `登記 ${repo} 的規格`,
  path: "規格路徑",
  pathHint: "儲存庫內以 / 分隔的相對路徑，結尾是 .md；檔案還不存在時，提交後才建立。",
  titleOptional: "標題（選填）",
  register: "登記規格",

  projectFallback: "專案",
  repoFallback: "儲存庫",
  draftHint:
    "這是規格的草稿，所有人可以一起編輯；按下「提交到儲存庫」才會開啟合併請求。代理要修改規格時會另外開啟合併請求，不會直接覆蓋草稿。",
  editorLabel: "規格草稿",
  prCreated: "已開啟合併請求：",
  prUpdated: "已更新合併請求：",
  prOpen: "開著的規格合併請求：",
  overwritesUpstream: (path: string) =>
    `預設分支上的 ${path} 在上次版本之後被修改過，這個合併請求會覆蓋那些修改，合併前請確認。`,
  commit: "提交到儲存庫",
  commitMessage: "提交訊息（選填）",
  commitPlaceholder: (path: string) => `docs: 更新 ${path}`,
};
