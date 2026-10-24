// 列舉值在 UI 上顯示的文字（原 lib/labels.ts）。zh-TW 的顯示文字照新工作區介面的原型，
// 對照表見 GLOSSARY 的「zh-TW 顯示」欄；程式碼仍用 GLOSSARY 的標準名詞。

import type {
  AcceptanceCriterionKind,
  AcceptanceCriterionResult,
  DelegationMode,
  DiffFileChange,
  NotificationKind,
  PermissionPolicy,
  QueueWaitingReason,
  READY_REQUIREMENTS,
  Role,
  RunnerKind,
  RunOrigin,
  RunStatus,
  TaskDoneReason,
  TaskStatus,
  VerificationResolution,
  VerificationStatus,
} from "@orbis/api-contract";
import type {
  MergeOutcome,
  PermissionPurpose,
  PlanSource,
  PreviewStopReason,
  PromptSource,
  RunErrorCode,
  ToolCallStatus,
  ToolKind,
  VerificationOutcome,
} from "@orbis/protocol";

export default {
  /** Task 狀態（看板分組、側欄、工作區）。 */
  taskStatus: {
    backlog: "待辦",
    ready: "就緒",
    planning: "規劃中",
    plan_gate: "計畫關卡",
    running: "執行中",
    verifying: "驗證中",
    review_gate: "審查關卡",
    pr_open: "合併請求已開啟",
    done: "完成",
  } satisfies Record<TaskStatus, string>,

  /** Done 的關閉原因。 */
  taskDoneReason: {
    completed: "已完成",
    not_planned: "不處理",
  } satisfies Record<TaskDoneReason, string>,

  /** Task 進入 Ready 缺少的項目。 */
  readyRequirement: {
    repo: "指定儲存庫",
    description: "描述或規格",
    acceptance_criteria: "至少一條驗收條件",
  } satisfies Record<(typeof READY_REQUIREMENTS)[number], string>,

  permissionPurpose: {
    tool: "權限請求",
    config_trust: "設定的信任核准",
    agent_settings_changed: "代理設定檔變更確認",
  } satisfies Record<PermissionPurpose, string>,

  role: {
    owner: "擁有者",
    admin: "管理員",
    member: "成員",
    viewer: "檢視者",
  } satisfies Record<Role, string>,

  runStatus: {
    queued: "排隊中",
    dispatched: "已派工",
    starting: "啟動中",
    running: "執行中",
    verifying: "驗證中",
    awaiting_permission: "等待權限回覆",
    rate_limited: "速率限制",
    awaiting_gate: "等待關卡",
    completed: "已完成",
    failed: "失敗",
    canceled: "已中止",
  } satisfies Record<RunStatus, string>,

  runnerKind: {
    local: "本機",
    team: "團隊",
  } satisfies Record<RunnerKind, string>,

  /** Permission Policy 的短名稱（輸入框按鈕）。 */
  permissionPolicy: {
    manual: "逐一確認",
    auto: "自動",
    yolo: "全部允許",
  } satisfies Record<PermissionPolicy, string>,

  /** Permission Policy 的一行說明（選單子說明）。 */
  permissionPolicyDescription: {
    manual: "每個動作都先詢問",
    auto: "一般操作自動允許，風險操作才詢問",
    yolo: "所有動作都不再詢問",
  } satisfies Record<PermissionPolicy, string>,

  acKind: {
    command: "指令",
    agent: "代理判定",
    browser: "瀏覽器",
    manual: "人工",
  } satisfies Record<AcceptanceCriterionKind, string>,

  acKindDescription: {
    command: "跑指定指令，成功就通過",
    agent: "讓代理比對規格來判斷",
    browser: "在預覽畫面實際操作檢查",
    manual: "在審查關卡由人工確認",
  } satisfies Record<AcceptanceCriterionKind, string>,

  acResult: {
    pending: "尚未判定",
    passed: "通過",
    failed: "失敗",
  } satisfies Record<AcceptanceCriterionResult, string>,

  toolKind: {
    read: "讀取",
    edit: "編輯",
    delete: "刪除",
    move: "移動",
    search: "搜尋",
    execute: "執行",
    think: "思考",
    fetch: "擷取",
    other: "其他",
  } satisfies Record<ToolKind, string>,

  toolCallStatus: {
    pending: "等待中",
    in_progress: "進行中",
    completed: "完成",
    failed: "失敗",
  } satisfies Record<ToolCallStatus, string>,

  runError: {
    agent_start_failed: "代理無法啟動",
    agent_crashed: "代理異常結束",
    agent_error: "代理回報錯誤",
    worktree_failed: "工作樹建立失敗",
    setup_failed: "工作樹設定失敗",
    git_failed: "git 操作失敗",
    path_too_long: "路徑太長",
    merge_child_conflict: "合併子執行時的衝突未解決",
    session_resume_failed: "無法恢復原本的工作階段",
    internal: "內部錯誤",
  } satisfies Record<RunErrorCode, string>,

  diffChange: {
    added: "新增",
    modified: "修改",
    deleted: "刪除",
    renamed: "改名",
  } satisfies Record<DiffFileChange, string>,

  /** Run 為什麼產生。 */
  runOrigin: {
    dispatch: "派工",
    delegation: "委派",
    verification: "驗收",
    mention: "@agent",
    feedback_loop: "回饋循環",
  } satisfies Record<RunOrigin, string>,

  delegationMode: {
    consult: "諮詢（唯讀）",
    branch: "分支（子分支）",
  } satisfies Record<DelegationMode, string>,

  /** 送給代理的 prompt 的來源。 */
  promptSource: {
    user: "派工",
    plan_gate: "計畫關卡退回",
    review_gate: "審查關卡退回",
    verification_retry: "驗收重試",
    feedback_review: "回饋循環（審查留言）",
    feedback_ci: "回饋循環（CI 失敗）",
    child_question: "回答子執行的問題",
  } satisfies Record<PromptSource, string>,

  planSource: {
    plan_mode: "計畫模式",
    prompt_fallback: "回合最後的訊息",
  } satisfies Record<PlanSource, string>,

  verificationOutcome: {
    passed: "通過",
    failed: "失敗",
    error: "無法判定",
  } satisfies Record<VerificationOutcome, string>,

  verificationStatus: {
    running: "進行中",
    passed: "通過",
    failed: "失敗",
    error: "無法判定",
    canceled: "已中止",
  } satisfies Record<VerificationStatus, string>,

  verificationResolution: {
    retry: "附意見再試",
    skip: "略過失敗，進入審查關卡",
    abort: "中止",
  } satisfies Record<VerificationResolution, string>,

  mergeOutcome: {
    merged: "已合併",
    conflict: "有衝突",
  } satisfies Record<MergeOutcome, string>,

  previewStopReason: {
    exited: "程序已結束",
    ready_timeout: "等待就緒逾時",
    spawn_failed: "無法啟動",
  } satisfies Record<PreviewStopReason, string>,

  notificationKind: {
    permission_request: "權限請求",
    gate_pending: "關卡等待核准",
    verification_failed: "驗收連續失敗",
    feedback_limit_reached: "回饋循環達到次數上限",
    mentioned: "被提及",
    task_assigned: "被指派任務",
    task_merged: "自己的任務已合併",
    task_rejected: "自己的任務被退回",
    run_stopped: "執行停下來等人處理",
  } satisfies Record<NotificationKind, string>,

  queueWaitingReason: {
    no_runner: "沒有在線的執行器",
    agent_unavailable: "沒有執行器能跑這個代理",
    concurrency_limit: "憑證已達並行上限",
    rate_limited: "憑證在速率限制中",
  } satisfies Record<QueueWaitingReason, string>,
};
