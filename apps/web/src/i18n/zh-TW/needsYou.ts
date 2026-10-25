// U2 的 needsYou 字典（待我處理）。key 由 U2 新增，en/needsYou.ts 要有相同的 key。顯示文字照原型。

export default {
  title: "待我處理",
  empty: "全部處理完了",
  group: {
    permission: "權限請求",
    plan_gate: "計畫關卡",
    review_gate: "審查關卡",
    stopped_run: "停下來的執行",
    child_question: "子執行的問題",
  },
  summary: {
    plan_gate: "等待核准計畫",
    review_gate: "等待審查差異",
  },
  go: {
    permission: "前往執行",
    plan_gate: "查看計畫",
    review_gate: "前往差異審查",
    stopped_run: "前往決定",
    child_question: "前往子執行",
  },
  /** 停下來的原因（Needs You 的 `reasonCode`）。 */
  stoppedReason: {
    verification_limit: (attempt: number) => `驗收連續失敗 ${attempt} 次`,
    push_failed: "push 分支失敗",
    pr_open_failed: "開合併請求失敗",
    local_merge_blocked: "本機合併被擋下",
  },
  answer: "回答",
  answerLabel: (key: string) => `回答 ${key} 的子執行`,
  answerPlaceholder: "回答子執行的問題",
};
