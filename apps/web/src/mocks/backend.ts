// MSW 假後端的狀態與行為：照 ARCHITECTURE 的規則推進 Task、Run 與 Needs You，
// Run 的 Event 由 scripts.ts 的劇本逐步產生。
//
// 狀態存在 sessionStorage，重新整理頁面後延續（Playwright 每個測試是新的 context，互不影響）。
// 這只是開發期間的鷹架；完成條件的 M1 路徑 e2e 跑在真實 Server + Runner + Fake Agent 上。

import {
  type AcceptanceCriterion,
  type AddMemberInput,
  type ApiError,
  type CollabMentionAttrs,
  type CreateAcceptanceCriterionInput,
  type CreateProjectInput,
  type CreateRepoInput,
  type CreateRepoSpecInput,
  type CreateRunInput,
  type CreateTaskInput,
  type CredentialStatus,
  canTransitionManually,
  type DispatchOptions,
  type DraftTask,
  formatMention,
  formatMentionTargetId,
  formatTaskKey,
  type Gate,
  type GateDecisionInput,
  type MarkNotificationsReadInput,
  type Member,
  type Mention,
  type MentionCandidates,
  type MeResponse,
  NAMES,
  type NeedsYouItem,
  type Notification,
  type NotificationKind,
  type NotificationListResponse,
  type NotificationPreferences,
  type PairingTokenCreated,
  type PreviewState,
  type Project,
  type ProjectMemberRole,
  parseCollabDocName,
  parseMentions,
  parseMentionTargetId,
  READY_REQUIREMENTS,
  type Repo,
  type RepoSpec,
  type RepoSpecCommitInput,
  type RepoSpecCommitResponse,
  type ReviewDiff,
  type Role,
  type Run,
  type RunEvent,
  type Runner,
  type RunnerKind,
  type RunUsage,
  type Task,
  type TaskComment,
  type TaskStatus,
  type Team,
  type TeamRunnerQueueItem,
  type UpdateAcceptanceCriterionInput,
  type UpdateDraftTaskInput,
  type UpdateProjectInput,
  type UpdateTaskInput,
  type Verification,
  type VerificationDecisionInput,
} from "@orbis/api-contract";
import type {
  EventKind,
  GateKind,
  PermissionPurpose,
  RunDiff,
  RunDiffFile,
  TextBody,
  VerificationEvidence,
} from "@orbis/protocol";
import type { BoardSummaryItem } from "../features/board/types";
import type {
  RunEffort,
  RunEventActors,
  RunSettings,
  TaskPullRequest,
  UpdateRunSettingsInput,
} from "../features/run/types";
import { MOCK_STATE_STORAGE_KEY, type MockConfig, mockConfig } from "./config";
import {
  BASE_COMMIT,
  BASE_FILES,
  configTrustTurn,
  emptyDiffTurn,
  generateLargeRun,
  implementTurn,
  m1FirstTurn,
  m1RevisionTurn,
  planRevisionTurn,
  planTurn,
  type ScriptStep,
  verificationFixTurn,
} from "./scripts";

export const ME_ID = "member-me";
export const LARGE_RUN_ID = "run-large";

/** 一個 Run 的模擬進度。 */
interface Simulation {
  /** 還沒送出的劇本步驟。 */
  queue: ScriptStep[];
  /** 等待回覆的權限請求。 */
  waiting: Extract<ScriptStep, { type: "await_permission" }> | null;
}

export interface MockState {
  /** Team 名稱（PATCH /api/team）；舊的 sessionStorage 狀態沒有這個欄位。 */
  teamName?: string;
  members: Member[];
  projects: Project[];
  repos: Repo[];
  tasks: Task[];
  acceptanceCriteria: AcceptanceCriterion[];
  runs: Run[];
  events: Record<string, RunEvent[]>;
  needsYou: NeedsYouItem[];
  gates: Gate[];
  simulations: Record<string, Simulation>;
  /** 收到的 Gate 決定（依 Run），測試用來檢查送出的內容。 */
  reviews: Record<string, GateDecisionInput[]>;
  /** 已登出：之後 `/api/auth/me` 回 401。 */
  loggedOut: boolean;
  /** blob 的內容（review diff 中放在 blob 的大檔；`data:` 開頭的是圖片）。 */
  blobs: Record<string, string>;
  nextId: number;
  verifications: Verification[];
  /**
   * 正在 Verification 的 Run：`running`＝已送 verify；`done`＝已收到 verification_completed，
   * 接著的 awaiting_gate(review) 是 Verification 結束的回報，不再開始新的一輪。
   */
  verificationPhase: Record<string, "running" | "done">;
  /** 每個 Run 跑過幾輪 Verification（決定 `verificationFailures` 的哪幾輪失敗）。 */
  verificationRounds: Record<string, number>;
  draftTasks: DraftTask[];
  /** 新的在後。 */
  notifications: Notification[];
  notificationPreferences: NotificationPreferences;
  taskComments: TaskComment[];
  mentions: Mention[];
  /** 共同編輯文件的 Yjs 狀態（base64），依文件名稱。 */
  collabDocs: Record<string, string>;
  repoSpecs: RepoSpec[];
  /** Repo Spec 草稿轉成的 markdown（提交時使用）。 */
  repoSpecDrafts: Record<string, string>;
  /** Credential 並行上限的覆寫，key 是 `<runnerId>/<credential>`。 */
  credentialOverrides: Record<string, number>;
  projectRoles: ProjectMemberRole[];
  /** 工作區的後端缺口（U2）：執行中切換的設定，依 Run。 */
  runSettings: Record<string, RunSettings>;
  /** 工作區的後端缺口（U2）：執行中傳訊息的作者，依 Run 再依 seq。 */
  promptAuthors: Record<string, Record<string, string>>;
}

/** 1×1 的 PNG，當作 browser 類型條件的截圖。 */
const SCREENSHOT_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** 以契約 ApiError 的形狀回應的錯誤。 */
export class MockError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Pick<ApiError, "issues" | "missing"> = {},
  ) {
    super(message);
  }
}

const ROLE_ORDER: readonly Role[] = ["viewer", "member", "admin", "owner"];

function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(minimum);
}

/** Server 的權限請求授權規則（ARCHITECTURE §8），假後端獨立實作一份。 */
function mayRespond(role: Role, run: Run, purpose: PermissionPurpose): boolean {
  if (purpose === "config_trust") return roleAtLeast(role, "admin");
  if (!roleAtLeast(role, "member")) return false;
  return run.runnerKind === "team" || run.startedByMemberId === ME_ID;
}

const EMPTY_USAGE: RunUsage = {
  inputTokens: null,
  outputTokens: null,
  thoughtTokens: null,
  cachedReadTokens: null,
  cachedWriteTokens: null,
  contextUsedTokens: null,
  contextWindowTokens: null,
  cost: null,
};

const SEED_TIME = "2026-10-20T08:00:00.000Z";

/** 假的 GitHub：App 安裝在這些擁有者底下，其他 repo 登記後顯示「未安裝」。 */
const GITHUB_APP_OWNERS: readonly string[] = ["acme"];
const GITHUB_APP_INSTALL_URL = `https://github.com/apps/${NAMES.productSlug}/installations/new`;
/** App 已安裝時，Server 從 GitHub 讀到的 default branch。 */
const GITHUB_DEFAULT_BRANCH = "main";

function now(): string {
  return new Date().toISOString();
}

type Listener = (runId: string, events: RunEvent[]) => void;
type NotificationListener = (notification: Notification) => void;

/** @mention 自動完成的 Agent。 */
const MENTION_AGENTS: MentionCandidates["agents"] = [
  { agent: "claude-code", label: "claude" },
  { agent: "codex", label: "codex" },
];

export class MockBackend {
  private state: MockState;
  private readonly listeners = new Set<Listener>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private largeRun: RunEvent[] | null = null;

  constructor(
    readonly config: MockConfig = mockConfig(),
    private readonly storage: Storage | null = typeof sessionStorage === "undefined"
      ? null
      : sessionStorage,
  ) {
    this.state = this.load() ?? this.seed();
    this.state.verifications ??= [];
    this.state.verificationPhase ??= {};
    this.state.verificationRounds ??= {};
    this.state.draftTasks ??= [];
    this.state.notifications ??= [];
    this.state.notificationPreferences ??= { disabledKinds: [], quietHours: null };
    this.state.taskComments ??= [];
    this.state.mentions ??= [];
    this.state.collabDocs ??= {};
    this.state.repoSpecs ??= [];
    this.state.repoSpecDrafts ??= {};
    this.state.credentialOverrides ??= {};
    this.state.projectRoles ??= [];
    this.state.runSettings ??= {};
    this.state.promptAuthors ??= {};
    this.save();
  }

  // ---------- 生命週期 ----------

  /** 開始依間隔推進模擬中的 Run。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.config.eventIntervalMs ?? 150);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onEvents(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 新的 App 內通知（WebSocket 的 `notification` 推送）。 */
  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /** 每個模擬中的 Run 前進一步。 */
  tick(): void {
    let changed = false;
    for (const [runId, simulation] of Object.entries(this.state.simulations)) {
      if (simulation.waiting) continue;
      const step = simulation.queue.shift();
      if (!step) continue;
      changed = true;
      if (step.type === "event") {
        // 進入 Review Gate 前，Runner 先送 Agent 最後的回覆，再送完整 diff（協定的 run_diff）
        const enteringReview =
          step.event.kind === "status_changed" &&
          step.event.status === "awaiting_gate" &&
          step.event.gate === "review";
        const diff: EventKind[] = enteringReview
          ? [
              { kind: "final_message", text: { type: "inline", text: this.turnText(runId) } },
              { kind: "run_diff", ...this.computeDiff(runId) },
            ]
          : [];
        this.append(runId, [...diff, step.event]);
      } else {
        simulation.waiting = step;
        this.append(runId, [
          { kind: "status_changed", status: "awaiting_permission", gate: null, message: null },
          step.request,
        ]);
      }
    }
    if (changed) this.save();
  }

  /** 讓所有模擬中的 Run 跑到需要人處理或劇本結束為止（建立種子資料用）。 */
  private settle(): void {
    for (let guard = 0; guard < 1_000; guard += 1) {
      const busy = Object.values(this.state.simulations).some(
        (s) => !s.waiting && s.queue.length > 0,
      );
      if (!busy) return;
      this.tick();
    }
  }

  // ---------- 持久化 ----------

  private load(): MockState | null {
    try {
      const raw = this.storage?.getItem(MOCK_STATE_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as MockState) : null;
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(MOCK_STATE_STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // 無法寫入時只在記憶體中保存
    }
  }

  private newId(prefix: string): string {
    this.state.nextId += 1;
    return `${prefix}-${this.state.nextId}`;
  }

  // ---------- 種子資料 ----------

  private seed(): MockState {
    this.state = {
      members: [
        member(ME_ID, 583231, "octocat", "The Octocat", this.config.role ?? "owner"),
        member("member-alice", 2, "alice", "Alice", "admin"),
        member("member-bob", 3, "bob", "Bob", "member"),
      ],
      projects: [
        {
          id: "project-1",
          teamId: "team-1",
          name: "核心產品",
          keyPrefix: "ORB",
          description: "",
          policy: {
            planGateEnabled: false,
            delegationEnabled: true,
            delegationAgents: null,
            forbidSelfApproval: false,
            memberCanDispatchToTeamRunner: true,
            defaultPermissionPolicy: "auto",
            autoCreateIssues: false,
            verificationMaxRetries: 3,
            feedbackBotAllowlist: [],
            ...this.config.policy,
          },
          viewerRole: this.role,
          createdAt: SEED_TIME,
          updatedAt: SEED_TIME,
        },
        {
          id: "project-2",
          teamId: "team-1",
          name: "文件網站",
          keyPrefix: "DOC",
          description: "",
          policy: {
            planGateEnabled: false,
            delegationEnabled: false,
            delegationAgents: null,
            forbidSelfApproval: false,
            memberCanDispatchToTeamRunner: false,
            defaultPermissionPolicy: "manual",
            autoCreateIssues: false,
            verificationMaxRetries: 3,
            feedbackBotAllowlist: [],
          },
          viewerRole: this.config.role ?? "owner",
          createdAt: SEED_TIME,
          updatedAt: SEED_TIME,
        },
      ],
      repos: [
        {
          id: "repo-1",
          projectId: "project-1",
          owner: "acme",
          name: "demo",
          defaultBranch: "main",
          github: { installed: true, installUrl: null },
          createdAt: SEED_TIME,
          updatedAt: SEED_TIME,
        },
        {
          id: "repo-2",
          projectId: "project-2",
          owner: "acme",
          name: "docs",
          defaultBranch: "main",
          github: { installed: true, installUrl: null },
          createdAt: SEED_TIME,
          updatedAt: SEED_TIME,
        },
      ],
      tasks: [],
      acceptanceCriteria: [],
      runs: [],
      events: {},
      needsYou: [],
      gates: [],
      simulations: {},
      reviews: {},
      loggedOut: false,
      blobs: {},
      nextId: 100,
      verifications: [],
      verificationPhase: {},
      verificationRounds: {},
      draftTasks: [],
      notifications: [],
      notificationPreferences: { disabledKinds: [], quietHours: null },
      taskComments: [],
      mentions: [],
      collabDocs: {},
      repoSpecs: [
        {
          id: "spec-1",
          repoId: "repo-1",
          path: "docs/specs/login.md",
          title: "登入",
          version: 2,
          committedSha: "1".repeat(40),
          openPullRequest: null,
          createdAt: SEED_TIME,
          updatedAt: SEED_TIME,
        },
      ],
      repoSpecDrafts: { "spec-1": "# 登入\n\n使用 GitHub 帳號登入。" },
      credentialOverrides: {},
      projectRoles: [{ projectId: "project-1", memberId: "member-bob", role: "viewer" }],
      runSettings: {},
      promptAuthors: {},
    };

    const seedTask = (title: string, status: TaskStatus, extra: Partial<Task> = {}) => {
      const task = this.createTask("project-1", {
        repoId: "repo-1",
        title,
        assigneeMemberId: ME_ID,
      });
      Object.assign(task, { status, ...extra });
      return task;
    };
    const backlog = seedTask("設定 CI 快取", "backlog", {
      assigneeMemberId: null,
      description: "CI 的 pnpm store 加上快取。",
      specPath: "docs/specs/login.md",
    });
    this.createAcceptanceCriterion(backlog.id, {
      kind: "command",
      description: "CI 通過",
      command: null,
    });
    const ready = seedTask("新增 hello.txt 並更新 README", "ready", {
      description: "在 repo 根目錄新增 `hello.txt`，並在 README 說明。",
    });
    this.createAcceptanceCriterion(ready.id, {
      kind: "command",
      description: "測試通過",
      command: "pnpm test",
    });
    this.createAcceptanceCriterion(ready.id, { kind: "manual", description: "README 文字通順" });

    // 等待權限請求的 Run
    const waiting = seedTask("寫入 config.json", "ready");
    this.dispatch(
      waiting.id,
      {
        agent: "claude-code",
        model: null,
        runnerKind: "local",
        permissionPolicy: "manual",
      },
      true,
    );

    // 等待 Review Gate 的 Run（劇本跑完第一回合，允許權限請求）
    const review = seedTask("整理 README", "ready", { assigneeMemberId: "member-alice" });
    const reviewRun = this.dispatch(
      review.id,
      {
        agent: "claude-code",
        model: null,
        runnerKind: "local",
        permissionPolicy: "auto",
      },
      true,
    );
    this.settle();
    this.respondToPermission(reviewRun.id, "perm-write-config", "allow");
    this.settle();
    if (this.config.childRuns) this.seedChildRuns(reviewRun);
    this.seedDraftTasks(reviewRun);
    this.notify("task_assigned", "你被指派了 ORB-2", {
      taskId: ready.id,
      taskKey: ready.key,
      url: `/tasks/${ready.key}`,
      actorMemberId: "member-alice",
    });
    for (const n of this.state.notifications) {
      if (n.kind === "task_assigned") n.readAt = SEED_TIME;
    }

    seedTask("升級相依套件", "done", { assigneeMemberId: "member-bob", doneReason: "completed" });

    // 5,000 筆 Event 的 Run：Event 不存進 sessionStorage，載入時再產生
    const large = seedTask("大量 Event 的 Run", "running");
    const largeRun = this.newRun(large.id, LARGE_RUN_ID, {
      agent: "codex",
      model: null,
      runnerKind: "team",
      permissionPolicy: "auto",
    });
    largeRun.status = "running";
    this.state.runs.push(largeRun);

    seedTask("改用另一套 CI", "done", { assigneeMemberId: null, doneReason: "not_planned" });

    // 等待設定的信任核准的 Run（只在指定時建立，避免影響其他測試的項目數）
    if (this.config.configTrust) {
      const trust = seedTask("執行 setup 腳本", "ready");
      const trustRun = this.dispatch(
        trust.id,
        {
          agent: "claude-code",
          model: null,
          runnerKind: "local",
          permissionPolicy: "auto",
        },
        true,
      );
      this.state.simulations[trustRun.id] = {
        queue: configTrustTurn(`feature/${trust.key.toLowerCase()}`),
        waiting: null,
      };
    }

    // 等待 Review Gate、diff 為空的 Run（只在指定時建立，避免影響其他測試的項目數）
    if (this.config.emptyDiff) {
      const empty = seedTask("回答：登入頁需要修改嗎？", "ready");
      const emptyRun = this.dispatch(
        empty.id,
        {
          agent: "codex",
          model: null,
          runnerKind: "local",
          permissionPolicy: "auto",
        },
        true,
      );
      this.state.simulations[emptyRun.id] = {
        queue: emptyDiffTurn(`feature/${empty.key.toLowerCase()}`),
        waiting: null,
      };
    }

    this.settle();
    for (const run of this.state.runs) run.createdAt = SEED_TIME;

    // 剛建立的 Team：還沒有任何 Project
    if (this.config.projects === "none") {
      Object.assign(this.state, {
        projects: [],
        repos: [],
        tasks: [],
        acceptanceCriteria: [],
        runs: [],
        events: {},
        needsYou: [],
        gates: [],
        simulations: {},
        draftTasks: [],
      });
    }
    return this.state;
  }

  // ---------- 讀取 ----------

  me(): MeResponse {
    const role = this.config.role ?? "owner";
    return {
      githubUserId: 583231,
      githubLogin: "octocat",
      name: "The Octocat",
      avatarUrl: null,
      member:
        this.config.session === "no-team"
          ? null
          : { id: ME_ID, teamId: "team-1", teamName: this.teamName(), role },
    };
  }

  private teamName(): string {
    return this.state.teamName ?? "核心團隊";
  }

  team(): Team {
    return { id: "team-1", name: this.teamName(), createdAt: SEED_TIME, updatedAt: SEED_TIME };
  }

  /** 修改 Team 名稱：Admin 以上。 */
  updateTeam(name: string): Team {
    if (!roleAtLeast(this.role, "admin")) {
      throw new MockError(403, "forbidden", "只有 Admin 以上可以修改 Team 名稱");
    }
    this.state.teamName = name;
    this.save();
    return this.team();
  }

  get snapshot(): Readonly<MockState> {
    return this.state;
  }

  logout(): void {
    this.state.loggedOut = true;
    this.save();
  }

  members(): Member[] {
    const role = this.config.role ?? "owner";
    return this.state.members.map((m) => (m.id === ME_ID ? { ...m, role } : m));
  }

  projects(): Project[] {
    return this.state.projects;
  }

  getProject(projectId: string): Project {
    return this.project(projectId);
  }

  repos(projectId: string): Repo[] {
    this.project(projectId);
    return this.state.repos.filter((r) => r.projectId === projectId);
  }

  tasks(projectId: string): Task[] {
    this.project(projectId);
    return this.state.tasks.filter((t) => t.projectId === projectId);
  }

  task(taskId: string): Task {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) throw new MockError(404, "not_found", "找不到這個 Task");
    return task;
  }

  taskByKey(key: string): Task {
    const task = this.state.tasks.find((t) => t.key === key);
    if (!task) throw new MockError(404, "not_found", `找不到 Task ${key}`);
    return task;
  }

  private project(projectId: string): Project {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) throw new MockError(404, "not_found", "找不到這個 Project");
    return project;
  }

  acceptanceCriteria(taskId: string): AcceptanceCriterion[] {
    return this.state.acceptanceCriteria
      .filter((c) => c.taskId === taskId)
      .sort((a, b) => a.position - b.position);
  }

  taskRuns(taskId: string): Run[] {
    this.task(taskId);
    return this.state.runs.filter((r) => r.taskId === taskId).reverse();
  }

  run(runId: string): Run {
    const run = this.state.runs.find((r) => r.id === runId);
    if (!run) throw new MockError(404, "not_found", "找不到這個 Run");
    return run;
  }

  events(runId: string, afterSeq = 0, limit = Number.POSITIVE_INFINITY): RunEvent[] {
    this.run(runId);
    const all = runId === LARGE_RUN_ID ? this.largeRunEvents() : (this.state.events[runId] ?? []);
    return all.filter((e) => e.seq > afterSeq).slice(0, limit);
  }

  private largeRunEvents(): RunEvent[] {
    this.largeRun ??= generateLargeRun(LARGE_RUN_ID, this.config.largeRunEvents ?? 5_000);
    return this.largeRun;
  }

  /** 和 Server 相同：權限請求列出本人有權回覆的；Gate 列出指派給本人、本人能核准的。 */
  needsYou(): NeedsYouItem[] {
    const role = this.role;
    return this.state.needsYou
      .filter((item) => {
        if (item.kind === "permission_request") {
          return mayRespond(role, this.run(item.runId), item.purpose);
        }
        if (item.memberId !== ME_ID) return false;
        return item.kind !== "gate" || this.mayApprove(this.task(item.taskId));
      })
      .map((item) => ({ ...item, memberId: ME_ID }));
  }

  /**
   * 登入者在「核心產品」Project 的有效 Role（假後端的資料與操作幾乎都在這個 Project）：
   * 有覆寫時用覆寫，但 Team 的 Owner 不能被覆寫（同 Server 的 effectiveRole）。
   */
  private get role(): Role {
    const teamRole = this.config.role ?? "owner";
    return teamRole === "owner" ? "owner" : (this.config.projectRole ?? teamRole);
  }

  /** 核准 Gate（§12.2）：Member 以上；禁止核准自己的 Task 時，Member 不能核准指派給自己的。 */
  private mayApprove(task: Task): boolean {
    const role = this.role;
    if (!roleAtLeast(role, "member")) return false;
    const policy = this.project(task.projectId).policy;
    return !(role === "member" && policy.forbidSelfApproval && task.assigneeMemberId === ME_ID);
  }

  taskGates(taskId: string): Gate[] {
    this.task(taskId);
    return this.state.gates.filter((g) => g.taskId === taskId);
  }

  dispatchOptions(projectId: string): DispatchOptions {
    const { defaultPermissionPolicy } = this.project(projectId).policy;
    if (this.config.runners === "none") return { local: null, team: null, defaultPermissionPolicy };
    return {
      defaultPermissionPolicy,
      local: {
        // 離線時 Agent 仍沿用最後回報的可用性（ARCHITECTURE §6.1：派工後 Run 停在佇列）
        online: this.config.runners !== "local-offline",
        agents: [
          {
            id: "claude-code",
            version: "2.1.0",
            available: true,
            unavailableReason: null,
            models: ["claude-opus-5-5", "claude-sonnet-5-5"],
            permissionGaps: [],
          },
          {
            id: "codex",
            version: null,
            available: false,
            unavailableReason: "未安裝",
            models: [],
            permissionGaps: [],
          },
          {
            id: "antigravity",
            version: "0.9.0",
            available: true,
            unavailableReason: null,
            models: [],
            permissionGaps: ["MCP server 的工具呼叫不會送出權限請求"],
          },
        ],
      },
      team: {
        online: true,
        agents: [
          {
            id: "claude-code",
            version: "2.1.0",
            available: true,
            unavailableReason: null,
            models: [],
            permissionGaps: [],
          },
          {
            id: "codex",
            version: "1.4.0",
            available: true,
            unavailableReason: null,
            models: ["gpt-5"],
            permissionGaps: [],
          },
        ],
      },
    };
  }

  /** 這個回合 Agent 說的話（最後一次進入 running 之後的 message_chunk），即協定的 final_message。 */
  private turnText(runId: string): string {
    const events = this.state.events[runId] ?? [];
    const start = events.findLastIndex(
      (e) => e.event.kind === "status_changed" && e.event.status === "running",
    );
    return events
      .slice(start + 1)
      .map(({ event }) =>
        event.kind === "message_chunk" && event.content.type === "text" ? event.content.text : "",
      )
      .join("");
  }

  /** 最新一份 review diff（最後一筆 run_diff Event），還沒有時 404。 */
  reviewDiff(runId: string): ReviewDiff {
    const events = this.events(runId);
    const latest = events.findLast((e) => e.event.kind === "run_diff");
    const diff = latest?.event;
    if (latest === undefined || diff?.kind !== "run_diff") {
      throw new MockError(404, "not_found", "找不到 review diff");
    }
    const final = events.findLast((e) => e.event.kind === "final_message" && e.seq < latest.seq);
    return {
      runId,
      seq: latest.seq,
      baseCommit: diff.base_commit,
      files: diff.files.map((file) => ({
        path: file.path,
        oldPath: file.old_path,
        change: file.change,
        binary: file.binary,
        old: file.old,
        new: file.new,
      })),
      finalMessage: final?.event.kind === "final_message" ? final.event.text : null,
    };
  }

  /** Review Gate 送審的那份 diff 是否沒有任何檔案變更（Server 的同名判斷）。 */
  private reviewDiffIsEmpty(gate: Gate): boolean {
    const row = this.events(gate.runId ?? "").find((e) => e.seq === gate.reviewDiffSeq);
    return row?.event.kind === "run_diff" && row.event.files.length === 0;
  }

  /** base_commit 與 Worktree 目前內容的 diff（Runner 的 run_diff）：重播 Run 中已完成的編輯。 */
  private computeDiff(runId: string): RunDiff {
    const contents = new Map<string, Extract<EventKind, { kind: "tool_call" }>["content"]>();
    const files = new Map<string, string | null>(Object.entries(BASE_FILES));
    for (const { event } of this.state.events[runId] ?? []) {
      if (event.kind !== "tool_call") continue;
      if (event.content) contents.set(event.tool_call_id, event.content);
      if (event.status !== "completed") continue;
      for (const content of contents.get(event.tool_call_id) ?? []) {
        if (content.type !== "diff") continue;
        files.set(content.path, content.new?.type === "inline" ? content.new.text : null);
      }
    }
    const changed: RunDiffFile[] = [];
    for (const [path, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      const base = BASE_FILES[path] ?? null;
      if (base === text) continue;
      changed.push({
        path,
        old_path: null,
        change: base === null ? "added" : text === null ? "deleted" : "modified",
        binary: false,
        old: base === null ? null : { type: "inline", text: base },
        new: text === null ? null : this.textBody(path, text),
      });
    }
    if (this.config.blobDiff) {
      changed.push({
        path: "logo.png",
        old_path: null,
        change: "added",
        binary: true,
        old: null,
        new: null,
      });
    }
    return { base_commit: BASE_COMMIT, files: changed };
  }

  /** 設定 `blobDiff` 時，README.md 修改後的內容放在 blob（模擬大檔）。 */
  private textBody(path: string, text: string): TextBody {
    if (!this.config.blobDiff || path !== "README.md") return { type: "inline", text };
    const blobId = this.newId("blob");
    this.state.blobs[blobId] = text;
    return {
      type: "blob",
      blob_id: blobId,
      sha256: "0".repeat(64),
      size: new TextEncoder().encode(text).length,
      media_type: "text/plain; charset=utf-8",
    };
  }

  blob(blobId: string): string {
    const text = this.state.blobs[blobId];
    if (text === undefined) throw new MockError(410, "gone", "blob 已超過保存期限");
    return text;
  }

  // ---------- 寫入 ----------

  private requireEditor(): void {
    if (this.config.forbidWrites || this.role === "viewer") {
      throw new MockError(403, "forbidden", "Viewer 不能修改");
    }
  }

  /** 同 Server：建立 Project 需要 Team Role 是 Admin 以上，Task Key 前綴不能重複（409）。 */
  createProject(input: CreateProjectInput): Project {
    const teamRole = this.config.role ?? "owner";
    if (this.config.forbidWrites || !roleAtLeast(teamRole, "admin")) {
      throw new MockError(403, "forbidden", "需要 Admin 以上的 Role");
    }
    if (this.state.projects.some((p) => p.keyPrefix === input.keyPrefix)) {
      throw new MockError(409, "conflict", `Task Key 前綴 ${input.keyPrefix} 已被使用`);
    }
    const time = now();
    const project: Project = {
      id: this.newId("project"),
      teamId: "team-1",
      name: input.name,
      keyPrefix: input.keyPrefix,
      description: input.description ?? "",
      // Server 的預設政策（資料表的預設值）
      policy: {
        planGateEnabled: true,
        delegationEnabled: true,
        delegationAgents: null,
        forbidSelfApproval: false,
        memberCanDispatchToTeamRunner: true,
        defaultPermissionPolicy: "auto",
        autoCreateIssues: true,
        verificationMaxRetries: 3,
        feedbackBotAllowlist: [],
        ...input.policy,
      },
      // 新的 Project 沒有 Role 覆寫
      viewerRole: teamRole,
      createdAt: time,
      updatedAt: time,
    };
    this.state.projects.push(project);
    this.save();
    return project;
  }

  /** 修改 Project 需要這個 Project 的有效 Role 是 Admin 以上。 */
  private requireProjectAdmin(project: Project): void {
    if (this.config.forbidWrites || !roleAtLeast(project.viewerRole, "admin")) {
      throw new MockError(403, "forbidden", "需要 Admin 以上的 Role");
    }
  }

  updateProject(projectId: string, input: UpdateProjectInput): Project {
    const project = this.project(projectId);
    this.requireProjectAdmin(project);
    Object.assign(project, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      policy: { ...project.policy, ...input.policy },
      updatedAt: now(),
    });
    this.save();
    return project;
  }

  /**
   * 同 Server（§11）：App 已安裝時用 GitHub 上的 default branch；還沒安裝時用輸入值，
   * 沒有指定就用 `main`。同一個 Project 重複登記回 409。
   */
  createRepo(projectId: string, input: CreateRepoInput): Repo {
    const project = this.project(projectId);
    this.requireProjectAdmin(project);
    const duplicate = this.state.repos.some(
      (r) => r.projectId === projectId && r.owner === input.owner && r.name === input.name,
    );
    if (duplicate) {
      throw new MockError(409, "conflict", `${input.owner}/${input.name} 已經登記在這個 Project`);
    }
    const installed = GITHUB_APP_OWNERS.includes(input.owner);
    const time = now();
    const repo: Repo = {
      id: this.newId("repo"),
      projectId,
      owner: input.owner,
      name: input.name,
      defaultBranch: installed ? GITHUB_DEFAULT_BRANCH : (input.defaultBranch ?? "main"),
      github: { installed, installUrl: installed ? null : GITHUB_APP_INSTALL_URL },
      createdAt: time,
      updatedAt: time,
    };
    this.state.repos.push(repo);
    this.save();
    return repo;
  }

  /** 重新讀取 GitHub App 的安裝狀態（#56）。 */
  refreshRepoInstallation(repoId: string): Repo {
    const repo = this.repo(repoId);
    this.requireProjectAdmin(this.project(repo.projectId));
    const fullName = `${repo.owner}/${repo.name}`;
    if (this.config.repoMismatch?.includes(fullName)) {
      throw new MockError(
        409,
        "repo_mismatch",
        `GitHub 上的 ${fullName} 與登記時不是同一個 repository`,
      );
    }
    const owners = this.config.githubAppOwnersOnRefresh ?? GITHUB_APP_OWNERS;
    const installed = owners.includes(repo.owner);
    repo.github = { installed, installUrl: installed ? null : GITHUB_APP_INSTALL_URL };
    repo.updatedAt = now();
    this.save();
    return repo;
  }

  deleteRepo(repoId: string): void {
    const repo = this.repo(repoId);
    this.requireProjectAdmin(this.project(repo.projectId));
    if (this.state.tasks.some((t) => t.repoId === repoId)) {
      throw new MockError(409, "conflict", "還有 Task 使用這個 Repo，不能刪除");
    }
    this.state.repos = this.state.repos.filter((r) => r.id !== repoId);
    this.save();
  }

  private repo(repoId: string): Repo {
    const repo = this.state.repos.find((r) => r.id === repoId);
    if (!repo) throw new MockError(404, "not_found", "找不到這個 Repo");
    return repo;
  }

  createTask(projectId: string, input: CreateTaskInput): Task {
    const project = this.project(projectId);
    const number = this.state.tasks.filter((t) => t.projectId === projectId).length + 1;
    const time = now();
    const task: Task = {
      id: this.newId("task"),
      key: formatTaskKey(project.keyPrefix, number),
      projectId,
      repoId: input.repoId,
      title: input.title,
      description: input.description ?? "",
      status: "backlog",
      doneReason: null,
      assigneeMemberId: input.assigneeMemberId ?? null,
      specPath: input.specPath ?? null,
      dependsOn: input.dependsOn ?? [],
      planGateEnabled: input.planGateEnabled ?? null,
      createdByMemberId: ME_ID,
      createdAt: time,
      updatedAt: time,
    };
    this.state.tasks.push(task);
    this.save();
    return task;
  }

  createTaskAsMember(projectId: string, input: CreateTaskInput): Task {
    this.requireEditor();
    return this.createTask(projectId, input);
  }

  updateTask(taskId: string, input: UpdateTaskInput): Task {
    this.requireEditor();
    const task = this.task(taskId);
    Object.assign(task, input, { updatedAt: now() });
    this.save();
    return task;
  }

  transitionTask(taskId: string, status: TaskStatus): Task {
    this.requireEditor();
    const task = this.task(taskId);
    if (!canTransitionManually(task.status, status)) {
      throw new MockError(409, "invalid_transition", `不能從 ${task.status} 轉換到 ${status}`);
    }
    // 進入 Ready 的條件（§5）：已指定 Repo、描述不為空或有連結的 Spec、至少一條 Acceptance Criterion
    if (status === "ready") {
      const satisfied = {
        repo: task.repoId !== null,
        description: task.description.trim() !== "" || task.specPath !== null,
        acceptance_criteria: this.acceptanceCriteria(task.id).length > 0,
      };
      const missing = READY_REQUIREMENTS.filter((r) => !satisfied[r]);
      if (missing.length > 0) {
        throw new MockError(409, "invalid_transition", "還不能進入 Ready", { missing });
      }
    }
    task.status = status;
    task.updatedAt = now();
    this.save();
    return task;
  }

  createAcceptanceCriterion(
    taskId: string,
    input: CreateAcceptanceCriterionInput,
  ): AcceptanceCriterion {
    const existing = this.acceptanceCriteria(taskId);
    const time = now();
    const criterion: AcceptanceCriterion = {
      id: this.newId("ac"),
      taskId,
      kind: input.kind,
      description: input.description,
      command: input.command ?? null,
      position: input.position ?? existing.length,
      result: "pending",
      resultUpdatedAt: null,
      resultSummary: null,
      checkedByRunId: null,
      checkedByMemberId: null,
      createdAt: time,
      updatedAt: time,
    };
    this.state.acceptanceCriteria.push(criterion);
    this.save();
    return criterion;
  }

  createAcceptanceCriterionAsMember(
    taskId: string,
    input: CreateAcceptanceCriterionInput,
  ): AcceptanceCriterion {
    this.requireEditor();
    this.task(taskId);
    return this.createAcceptanceCriterion(taskId, input);
  }

  updateAcceptanceCriterion(
    id: string,
    input: UpdateAcceptanceCriterionInput,
  ): AcceptanceCriterion {
    this.requireEditor();
    const criterion = this.state.acceptanceCriteria.find((c) => c.id === id);
    if (!criterion) throw new MockError(404, "not_found", "找不到這條 Acceptance Criterion");
    const merged = { ...criterion, ...input };
    if (merged.kind !== "command" && merged.command !== null) {
      throw new MockError(400, "invalid_input", "只有 command 類型可以設定指令");
    }
    Object.assign(criterion, input, { updatedAt: now() });
    this.save();
    return criterion;
  }

  deleteAcceptanceCriterion(id: string): void {
    this.requireEditor();
    this.state.acceptanceCriteria = this.state.acceptanceCriteria.filter((c) => c.id !== id);
    this.save();
  }

  private newRun(
    taskId: string,
    id: string,
    input: CreateRunInput & { permissionPolicy: Run["permissionPolicy"] },
  ): Run {
    const time = now();
    return {
      id,
      taskId,
      parentRunId: null,
      delegationMode: null,
      agent: input.agent,
      model: input.model ?? null,
      permissionPolicy: input.permissionPolicy,
      runnerKind: input.runnerKind,
      runnerId: null,
      worktreePath: null,
      branch: null,
      baseCommit: null,
      status: "queued",
      usage: { ...EMPTY_USAGE },
      startedByMemberId: ME_ID,
      origin: "dispatch",
      credential: null,
      consultOfRunId: null,
      resumesRunId: null,
      createdAt: time,
      startedAt: null,
      endedAt: null,
      updatedAt: time,
    };
  }

  /**
   * 派工：建立 Run。Plan Gate 開啟時 Task 進入 Planning，否則直接 Running。
   * 種子資料的 Run 一律略過 Plan Gate（`seeding`），不受測試設定的政策影響。
   */
  dispatch(taskId: string, input: CreateRunInput, seeding = false): Run {
    const task = this.task(taskId);
    if (task.status !== "ready") {
      throw new MockError(409, "invalid_transition", "只有 Ready 的 Task 可以派工");
    }
    const blocked = task.dependsOn.some((id) => this.task(id).status !== "done");
    if (blocked) throw new MockError(409, "conflict", "相依的 Task 還沒完成，不能派工");
    // 省略時用 Project 的預設；Project 預設是 yolo 又派到 Team Runner 時回 422（同 Server）
    const permissionPolicy =
      input.permissionPolicy ?? this.project(task.projectId).policy.defaultPermissionPolicy;
    if (permissionPolicy === "yolo" && input.runnerKind === "team") {
      throw new MockError(422, "invalid_input", "Team Runner 不接受 yolo 的 Permission Policy");
    }
    const run = this.newRun(taskId, this.newId("run"), { ...input, permissionPolicy });
    run.runnerId = input.runnerKind === "local" ? "runner-local" : "runner-team";
    this.state.runs.push(run);
    this.state.events[run.id] = [];
    const branch = `feature/${task.key.toLowerCase()}`;
    const planGate = !seeding && this.planGateEnabled(task);
    this.state.simulations[run.id] = {
      queue: planGate ? planTurn(branch) : m1FirstTurn(branch),
      waiting: null,
    };
    task.status = planGate ? "planning" : "running";
    task.updatedAt = now();
    this.save();
    return run;
  }

  /** Task 的覆寫優先，否則沿用 Project 的設定（§5）。 */
  private planGateEnabled(task: Task): boolean {
    return task.planGateEnabled ?? this.project(task.projectId).policy.planGateEnabled;
  }

  dispatchAsMember(taskId: string, input: CreateRunInput): Run {
    this.requireEditor();
    return this.dispatch(taskId, input);
  }

  respondToPermission(runId: string, requestId: string, optionId: string): void {
    const simulation = this.state.simulations[runId];
    const waiting = simulation?.waiting;
    if (!simulation || waiting?.request.request_id !== requestId) {
      throw new MockError(409, "unknown_permission_request", "這個權限請求已經處理過了");
    }
    const option = waiting.request.options.find((o) => o.option_id === optionId);
    if (!option) throw new MockError(400, "invalid_input", "沒有這個選項");
    simulation.waiting = null;
    this.append(runId, [
      { kind: "permission_resolved", request_id: requestId, selected_option_id: optionId },
      { kind: "status_changed", status: "running", gate: null, message: null },
    ]);
    simulation.queue.unshift(...(option.kind.startsWith("allow") ? waiting.allow : waiting.reject));
    this.save();
  }

  respondToPermissionAsMember(runId: string, requestId: string, optionId: string): void {
    if (this.config.forbidWrites) throw new MockError(403, "forbidden", "沒有權限");
    const run = this.run(runId);
    const request = this.state.simulations[runId]?.waiting?.request;
    if (request?.request_id === requestId && !mayRespond(this.role, run, request.purpose)) {
      throw new MockError(
        403,
        "forbidden",
        request.purpose === "config_trust"
          ? "設定的信任核准需要 admin 以上的 Role"
          : "只有這台 Local Runner 的擁有者能回覆它的權限請求",
      );
    }
    this.respondToPermission(runId, requestId, optionId);
  }

  decideGate(gateId: string, input: GateDecisionInput): Gate {
    this.requireEditor();
    const gate = this.state.gates.find((g) => g.id === gateId);
    if (!gate) throw new MockError(404, "not_found", "找不到這個 Gate");
    if (gate.decision !== null) throw new MockError(409, "conflict", "這個 Gate 已經有決定了");
    const task = this.task(gate.taskId);
    // 結束（沒有變更）等於核准這一版，權限與 manual 條件的要求都和核准相同
    const approving = input.action === "approve" || input.action === "finish_without_changes";
    if (approving && !this.mayApprove(task)) {
      throw new MockError(403, "forbidden", "這個 Project 不允許核准指派給自己的 Task");
    }
    if (gate.kind === "plan" && input.action === "finish_without_changes") {
      throw new MockError(422, "invalid_input", "只有 Review Gate 可以結束（沒有變更）");
    }
    if (
      gate.kind === "plan" &&
      input.action === "reject" &&
      ((input.reviewComments ?? []).length > 0 || (input.previewComments ?? []).length > 0)
    ) {
      throw new MockError(422, "invalid_input", "Plan Gate 只接受整體說明");
    }
    if (gate.kind === "review" && approving) {
      const empty = this.reviewDiffIsEmpty(gate);
      if (empty && input.action === "approve") {
        throw new MockError(409, "conflict", "diff 是空的，沒有變更可以 push");
      }
      if (!empty && input.action === "finish_without_changes") {
        throw new MockError(409, "conflict", "diff 不是空的，不能結束（沒有變更）");
      }
      const unchecked = this.acceptanceCriteria(task.id).filter(
        (c) => c.kind === "manual" && c.result !== "passed",
      );
      if (unchecked.length > 0) {
        throw new MockError(
          409,
          "manual_criteria_unchecked",
          `還有 ${unchecked.length} 條 manual 條件沒有打勾`,
        );
      }
    }
    const runId = gate.runId ?? "";
    this.state.reviews[runId] = [...(this.state.reviews[runId] ?? []), input];
    const time = now();
    Object.assign(gate, {
      decision: approving ? "approved" : "rejected",
      finishedWithoutChanges: input.action === "finish_without_changes",
      decidedByMemberId: ME_ID,
      decidedAt: time,
      comment: input.action === "reject" ? (input.comment ?? null) : null,
      reviewComments:
        input.action === "reject"
          ? (input.reviewComments ?? []).map((c) => ({
              ...c,
              id: this.newId("review-comment"),
              gateId: gate.id,
              authorMemberId: ME_ID,
              consultRunIds: [],
              createdAt: time,
              updatedAt: time,
            }))
          : [],
      previewComments:
        input.action === "reject"
          ? (input.previewComments ?? []).map((c) => ({
              body: c.body,
              url: c.url,
              selector: c.selector ?? null,
              screenshotBlobId: c.screenshotBlobId ?? null,
              id: this.newId("preview-comment"),
              gateId: gate.id,
              authorMemberId: ME_ID,
              createdAt: time,
              updatedAt: time,
            }))
          : [],
    });
    this.state.needsYou = this.state.needsYou.filter(
      (i) => !(i.kind === "gate" && i.runId === runId),
    );
    for (const comment of gate.reviewComments) {
      comment.consultRunIds = this.consultForMentions(
        task,
        comment.body,
        "review_comment",
        comment.id,
      );
    }
    const prompt = (source: "plan_gate" | "review_gate", text: string): ScriptStep => ({
      type: "event",
      event: { kind: "prompt_submitted", source, prompt: [{ type: "text", text }] },
    });
    if (gate.kind === "plan" && input.action !== "abort") {
      const approved = input.action === "approve";
      const branch = this.run(runId).branch ?? `feature/${task.key.toLowerCase()}`;
      this.state.simulations[runId] = {
        queue: approved
          ? [prompt("plan_gate", "plan 已核准，開始實作。"), ...implementTurn(branch)]
          : [
              prompt("plan_gate", input.action === "reject" ? (input.comment ?? "") : ""),
              ...planRevisionTurn(),
            ],
        waiting: null,
      };
      task.status = approved ? "running" : "planning";
    } else if (input.action === "reject") {
      const lines = [
        input.comment ?? "",
        ...(input.reviewComments ?? []).map((c) => `${c.path}:${c.line} ${c.body}`),
        ...(input.previewComments ?? []).map((c) => `${c.url} ${c.body}`),
      ];
      this.state.simulations[runId] = {
        queue: [prompt("review_gate", lines.filter(Boolean).join("\n")), ...m1RevisionTurn()],
        waiting: null,
      };
      task.status = "running";
    } else if (input.action === "approve") {
      this.append(runId, [
        { kind: "status_changed", status: "completed", gate: null, message: "Review Gate 核准" },
      ]);
      task.status = "pr_open";
    } else if (input.action === "finish_without_changes") {
      // 不 push、不開 PR：Run 以 cancel 結束，Task 轉 Done（關閉原因 completed）
      this.cancelRun(runId);
      task.status = "done";
      task.doneReason = "completed";
    } else {
      this.cancelRun(runId);
    }
    task.updatedAt = now();
    this.save();
    return gate;
  }

  // ---------- Preview（ARCHITECTURE §13；E 軌的 Preview 分頁） ----------

  previewState(runId: string): PreviewState {
    const run = this.run(runId);
    if (!this.config.preview) {
      return {
        status: "not_configured",
        port: null,
        localUrl: null,
        shareUrl: null,
        runnerId: run.runnerId,
        stopped: null,
      };
    }
    return {
      status: "ready",
      port: 4123,
      localUrl: "http://localhost:4123/",
      // 測試只檢查 iframe 的網址，不需要真的有 dev server
      shareUrl: "http://127.0.0.1:9/",
      runnerId: run.runnerId,
      stopped: null,
    };
  }

  /** 上傳 Preview 留言的截圖：存成 data URL 的 blob，Review 頁可以顯示。 */
  async uploadPreviewScreenshot(runId: string, file: Blob): Promise<{ blobId: string }> {
    this.run(runId);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const blobId = this.newId("blob");
    this.state.blobs[blobId] = `data:image/png;base64,${btoa(binary)}`;
    this.save();
    return { blobId };
  }

  // ---------- 共同編輯（ARCHITECTURE §12.1；collab.ts 的 MockCollabServer 使用） ----------

  get collabCloseCode(): number | null {
    return this.config.collabClose ?? null;
  }

  get collabPeer(): { name: string; color: string; editText: string | null } | null {
    if (!this.config.collabPeer) return null;
    return {
      name: "alice",
      color: "#6f42c1",
      editText: this.config.collabPeer === "edit" ? "alice 補充的一段" : null,
    };
  }

  collabAccess(docName: string): { readOnly: boolean; initialMarkdown: string } | null {
    const ref = parseCollabDocName(docName);
    if (!ref) return null;
    const readOnly = this.role === "viewer";
    switch (ref.kind) {
      case "task-description": {
        const task = this.state.tasks.find((t) => t.id === ref.id);
        return task ? { readOnly, initialMarkdown: task.description } : null;
      }
      case "acceptance-criterion": {
        const criterion = this.state.acceptanceCriteria.find((c) => c.id === ref.id);
        return criterion ? { readOnly, initialMarkdown: criterion.description } : null;
      }
      case "repo-spec-draft": {
        const spec = this.state.repoSpecs.find((s) => s.id === ref.id);
        return spec
          ? { readOnly, initialMarkdown: this.state.repoSpecDrafts[spec.id] ?? "" }
          : null;
      }
    }
  }

  collabSnapshot(docName: string): string | null {
    return this.state.collabDocs[docName] ?? null;
  }

  /** 保存文件，並把 markdown 回寫 Task 描述或條件的描述（Repo Spec 草稿只存快照）。 */
  saveCollabDocument(
    docName: string,
    snapshot: string,
    markdown: string,
    mentions: CollabMentionAttrs[],
  ): void {
    const ref = parseCollabDocName(docName);
    if (!ref) return;
    this.state.collabDocs[docName] = snapshot;
    let task: Task | null = null;
    if (ref.kind === "task-description") {
      task = this.state.tasks.find((t) => t.id === ref.id) ?? null;
      if (task) Object.assign(task, { description: markdown, updatedAt: now() });
    } else if (ref.kind === "acceptance-criterion") {
      const criterion = this.state.acceptanceCriteria.find((c) => c.id === ref.id);
      if (criterion && markdown.trim() !== "") {
        Object.assign(criterion, { description: markdown.trim(), updatedAt: now() });
      }
      task = criterion ? this.task(criterion.taskId) : null;
    } else {
      this.state.repoSpecDrafts[ref.id] = markdown;
    }
    if (task) {
      // 新出現的 mention 節點才發通知或建立 consult Run（以 nodeId 去除重複）
      const valid = mentions.flatMap((m) => {
        const target = parseMentionTargetId(m.id);
        return target && m.nodeId
          ? [{ token: formatMention(m.label, target), nodeId: m.nodeId }]
          : [];
      });
      this.consultForMentions(
        task,
        valid.map((m) => m.token).join(" "),
        "collab_document",
        docName,
        valid.map((m) => m.nodeId),
      );
    }
    this.save();
  }

  // ---------- Repo Spec（ARCHITECTURE §12.1） ----------

  repoSpecs(repoId: string): RepoSpec[] {
    this.repo(repoId);
    return this.state.repoSpecs.filter((s) => s.repoId === repoId);
  }

  repoSpec(id: string): RepoSpec {
    const spec = this.state.repoSpecs.find((s) => s.id === id);
    if (!spec) throw new MockError(404, "not_found", "找不到這份 Repo Spec");
    return spec;
  }

  createRepoSpec(repoId: string, input: CreateRepoSpecInput): RepoSpec {
    this.requireEditor();
    this.repo(repoId);
    if (this.state.repoSpecs.some((s) => s.repoId === repoId && s.path === input.path)) {
      throw new MockError(409, "conflict", `${input.path} 已經登記`);
    }
    const time = now();
    const spec: RepoSpec = {
      id: this.newId("spec"),
      repoId,
      path: input.path,
      title: input.title ?? null,
      version: 0,
      committedSha: null,
      openPullRequest: null,
      createdAt: time,
      updatedAt: time,
    };
    this.state.repoSpecs.push(spec);
    this.save();
    return spec;
  }

  /** 提交草稿：開 Spec PR，已經有開著的 PR 時更新它。 */
  commitRepoSpec(id: string, _input: RepoSpecCommitInput): RepoSpecCommitResponse {
    this.requireEditor();
    const spec = this.repoSpec(id);
    const repo = this.repo(spec.repoId);
    const created = spec.openPullRequest === null;
    spec.openPullRequest ??= {
      number: 40 + this.state.repoSpecs.indexOf(spec),
      url: `https://github.com/${repo.owner}/${repo.name}/pull/${40 + this.state.repoSpecs.indexOf(spec)}`,
    };
    spec.updatedAt = now();
    this.save();
    return {
      pullRequest: spec.openPullRequest,
      created,
      overwritesUpstreamChanges: this.config.specUpstreamChanged ?? false,
    };
  }

  // ---------- Runner、Credential 與佇列（ARCHITECTURE §6.1、§7） ----------

  private get teamRole(): Role {
    return this.config.role ?? "owner";
  }

  private requireTeamAdmin(): void {
    if (this.config.forbidWrites || !roleAtLeast(this.teamRole, "admin")) {
      throw new MockError(403, "forbidden", "需要 Admin 以上的 Role");
    }
  }

  runners(): Runner[] {
    const agent = (name: string, credential: string | null) => ({
      agent: name,
      credential,
      available: true,
      maxConcurrency: 30,
      details: null,
    });
    const all: Runner[] = [
      {
        id: "runner-team",
        teamId: "team-1",
        kind: "team",
        memberId: null,
        name: "team-runner-1",
        runnerVersion: "0.2.0",
        os: "linux",
        arch: "x64",
        online: true,
        acceptingDispatches: true,
        lastHeartbeatAt: SEED_TIME,
        agents: [agent("claude-code", "team-claude"), agent("codex", "team-openai")],
        createdAt: SEED_TIME,
      },
      {
        id: "runner-local",
        teamId: "team-1",
        kind: "local",
        memberId: ME_ID,
        name: "octocat-laptop",
        runnerVersion: "0.2.0",
        os: "windows",
        arch: "x64",
        online: true,
        acceptingDispatches: true,
        lastHeartbeatAt: SEED_TIME,
        agents: [agent("claude-code", "default")],
        createdAt: SEED_TIME,
      },
      {
        id: "runner-alice",
        teamId: "team-1",
        kind: "local",
        memberId: "member-alice",
        name: "alice-mac",
        runnerVersion: "0.2.0",
        os: "macos",
        arch: "arm64",
        online: false,
        acceptingDispatches: true,
        lastHeartbeatAt: SEED_TIME,
        agents: [agent("claude-code", "default")],
        createdAt: SEED_TIME,
      },
    ];
    // 同 Server：Admin 以上看得到全部，其他人只看得到 Team Runner 與自己的 Local Runner
    return roleAtLeast(this.teamRole, "admin")
      ? all
      : all.filter((r) => r.kind === "team" || r.memberId === ME_ID);
  }

  credentials(): CredentialStatus[] {
    return this.runners().flatMap((runner) => {
      const groups = new Map<string, string[]>();
      for (const a of runner.agents) {
        if (a.credential) groups.set(a.credential, [...(groups.get(a.credential) ?? []), a.agent]);
      }
      return [...groups].map(([credential, agents]): CredentialStatus => {
        const override = this.state.credentialOverrides[`${runner.id}/${credential}`] ?? null;
        const team = runner.kind === "team";
        return {
          runnerId: runner.id,
          runnerName: runner.name,
          runnerKind: runner.kind,
          online: runner.online,
          credential,
          agents,
          reportedMaxConcurrentRuns: 30,
          maxConcurrentRunsOverride: override,
          maxConcurrentRuns: override ?? 30,
          activeRuns: team && credential === "team-claude" ? 2 : 0,
          queuedRuns: team && credential === "team-claude" ? 1 : 0,
          rateLimitedUntil:
            team && credential === "team-claude" ? "2026-10-24T10:30:00.000Z" : null,
          usage24h: {
            runs: team ? 12 : 3,
            inputTokens: team ? 1_250_000 : 80_000,
            outputTokens: team ? 64_000 : null,
            cost: team ? { amount: 18.5, currency: "USD" } : null,
          },
        };
      });
    });
  }

  updateRunnerCredential(runnerId: string, credential: string, value: number | null): void {
    this.requireTeamAdmin();
    const key = `${runnerId}/${credential}`;
    if (value === null) delete this.state.credentialOverrides[key];
    else this.state.credentialOverrides[key] = value;
    this.save();
  }

  teamRunnerQueue(): TeamRunnerQueueItem[] {
    const task = this.state.tasks.find((t) => t.projectId === "project-1");
    if (!task) return [];
    return [
      {
        runId: "run-queued",
        taskId: task.id,
        taskKey: task.key,
        agent: "claude-code",
        credential: "team-claude",
        position: 1,
        waitingReason: "rate_limited",
        queuedAt: SEED_TIME,
      },
    ];
  }

  createPairingToken(kind: RunnerKind): PairingTokenCreated {
    if (kind === "team") this.requireTeamAdmin();
    return {
      id: this.newId("pairing"),
      kind,
      token: `pt_${kind}_${this.state.nextId}_mocktoken`,
      expiresAt: "2026-10-25T08:00:00.000Z",
    };
  }

  // ---------- 成員與 Project 的 Role 覆寫（ARCHITECTURE §12.2） ----------

  /** 只有 Owner 能指派或改動 Owner。 */
  private requireCanAssign(role: Role): void {
    if (role === "owner" && this.teamRole !== "owner") {
      throw new MockError(403, "forbidden", "只有 Owner 能指派或移除 Owner");
    }
  }

  private lastOwnerGuard(member: Member, next: Role | null): void {
    const owners = this.state.members.filter((m) => m.role === "owner");
    if (member.role === "owner" && next !== "owner" && owners.length === 1) {
      throw new MockError(409, "last_owner", "不能移除或降級最後一位 Owner");
    }
  }

  addMember(input: AddMemberInput): Member {
    this.requireTeamAdmin();
    const role = input.role ?? "member";
    this.requireCanAssign(role);
    if (input.githubLogin === "ghost") {
      throw new MockError(404, "not_found", "GitHub 上找不到 ghost");
    }
    if (this.state.members.some((m) => m.githubLogin === input.githubLogin)) {
      throw new MockError(409, "conflict", `${input.githubLogin} 已經是 Member`);
    }
    const created = member(
      this.newId("member"),
      1000 + this.state.nextId,
      input.githubLogin,
      input.githubLogin,
      role,
    );
    created.name = null;
    this.state.members.push(created);
    this.save();
    return created;
  }

  updateMember(memberId: string, role: Role): Member {
    this.requireTeamAdmin();
    const target = this.state.members.find((m) => m.id === memberId);
    if (!target) throw new MockError(404, "not_found", "找不到這位 Member");
    this.requireCanAssign(target.role);
    this.requireCanAssign(role);
    this.lastOwnerGuard(target, role);
    target.role = role;
    target.updatedAt = now();
    this.save();
    return target;
  }

  removeMember(memberId: string): void {
    this.requireTeamAdmin();
    const target = this.state.members.find((m) => m.id === memberId);
    if (!target) throw new MockError(404, "not_found", "找不到這位 Member");
    this.requireCanAssign(target.role);
    this.lastOwnerGuard(target, null);
    this.state.members = this.state.members.filter((m) => m !== target);
    this.save();
  }

  projectRoles(projectId: string): ProjectMemberRole[] {
    this.requireProjectAdmin(this.project(projectId));
    return this.state.projectRoles.filter((r) => r.projectId === projectId);
  }

  setProjectRole(
    projectId: string,
    memberId: string,
    role: ProjectMemberRole["role"],
  ): ProjectMemberRole {
    this.requireProjectAdmin(this.project(projectId));
    const target = this.state.members.find((m) => m.id === memberId);
    if (!target) throw new MockError(404, "not_found", "找不到這位 Member");
    if (target.role === "owner") {
      throw new MockError(422, "invalid_input", "Team 的 Owner 不能被覆寫");
    }
    this.state.projectRoles = [
      ...this.state.projectRoles.filter(
        (r) => !(r.projectId === projectId && r.memberId === memberId),
      ),
      { projectId, memberId, role },
    ];
    this.save();
    return { projectId, memberId, role };
  }

  deleteProjectRole(projectId: string, memberId: string): void {
    this.requireProjectAdmin(this.project(projectId));
    this.state.projectRoles = this.state.projectRoles.filter(
      (r) => !(r.projectId === projectId && r.memberId === memberId),
    );
    this.save();
  }

  // ---------- 通知（ARCHITECTURE §12.3） ----------

  /** 依個人設定建立 App 內通知並推送；關閉的事件類型不建立。 */
  private notify(
    kind: NotificationKind,
    title: string,
    extra: Partial<
      Pick<
        Notification,
        "taskId" | "taskKey" | "runId" | "gateId" | "url" | "body" | "actorMemberId"
      >
    >,
  ): void {
    if (this.state.notificationPreferences.disabledKinds.includes(kind)) return;
    const notification: Notification = {
      id: this.newId("notification"),
      kind,
      taskId: null,
      taskKey: null,
      runId: null,
      gateId: null,
      actorMemberId: null,
      title,
      body: null,
      url: null,
      readAt: null,
      createdAt: now(),
      ...extra,
    };
    this.state.notifications.push(notification);
    for (const listener of this.notificationListeners) listener(notification);
  }

  notifications(
    unreadOnly: boolean,
    before: string | null,
    limit: number,
  ): NotificationListResponse {
    let list = [...this.state.notifications].reverse();
    if (unreadOnly) list = list.filter((n) => n.readAt === null);
    if (before) list = list.slice(list.findIndex((n) => n.id === before) + 1);
    const items = list.slice(0, limit);
    return { items, nextBefore: list.length > limit ? (items.at(-1)?.id ?? null) : null };
  }

  unreadNotificationCount(): { count: number } {
    return { count: this.state.notifications.filter((n) => n.readAt === null).length };
  }

  markNotificationsRead(input: MarkNotificationsReadInput): void {
    const time = now();
    for (const n of this.state.notifications) {
      if (n.readAt === null && ("all" in input || input.ids.includes(n.id))) n.readAt = time;
    }
    this.save();
  }

  notificationPreferences(): NotificationPreferences {
    return this.state.notificationPreferences;
  }

  updateNotificationPreferences(input: NotificationPreferences): NotificationPreferences {
    this.state.notificationPreferences = input;
    this.save();
    return input;
  }

  // ---------- 留言與 @mention（ARCHITECTURE §12.3） ----------

  mentionCandidates(projectId: string): MentionCandidates {
    this.project(projectId);
    return {
      members: this.members().map((m) => ({
        memberId: m.id,
        githubLogin: m.githubLogin,
        name: m.name,
        avatarUrl: m.avatarUrl,
      })),
      agents: MENTION_AGENTS,
    };
  }

  taskComments(taskId: string): TaskComment[] {
    this.task(taskId);
    return this.state.taskComments.filter((c) => c.taskId === taskId);
  }

  taskMentions(taskId: string): Mention[] {
    this.task(taskId);
    return this.state.mentions.filter((m) => this.mentionTaskId(m) === taskId);
  }

  private mentionTaskId(mention: Mention): string | null {
    if (mention.sourceKind === "task_comment") {
      return this.state.taskComments.find((c) => c.id === mention.sourceId)?.taskId ?? null;
    }
    if (mention.sourceKind === "review_comment") {
      return (
        this.state.gates.find((g) => g.reviewComments.some((c) => c.id === mention.sourceId))
          ?.taskId ?? null
      );
    }
    // 共同編輯文件：sourceId 是文件名稱 `<種類>:<ID>`
    const [kind, id] = mention.sourceId.split(":");
    if (kind === "task-description") return id ?? null;
    if (kind === "acceptance-criterion") {
      return this.state.acceptanceCriteria.find((c) => c.id === id)?.taskId ?? null;
    }
    return null;
  }

  /** 留言時任何人都可以（Viewer 也能留言，§12.2）。 */
  createTaskComment(taskId: string, body: string): TaskComment {
    if (this.config.forbidWrites) throw new MockError(403, "forbidden", "沒有權限");
    const task = this.task(taskId);
    const time = now();
    const comment: TaskComment = {
      id: this.newId("comment"),
      taskId,
      authorMemberId: ME_ID,
      authorRunId: null,
      body,
      consultRunIds: [],
      createdAt: time,
      updatedAt: time,
    };
    this.state.taskComments.push(comment);
    comment.consultRunIds = this.consultForMentions(task, body, "task_comment", comment.id);
    this.save();
    return comment;
  }

  updateTaskComment(commentId: string, body: string): TaskComment {
    const comment = this.ownComment(commentId);
    const task = this.task(comment.taskId);
    comment.body = body;
    comment.updatedAt = now();
    // 新增的 @mention 才建立 Run
    comment.consultRunIds = [
      ...comment.consultRunIds,
      ...this.consultForMentions(task, body, "task_comment", comment.id),
    ];
    this.save();
    return comment;
  }

  deleteTaskComment(commentId: string): void {
    const comment = this.ownComment(commentId);
    this.state.taskComments = this.state.taskComments.filter((c) => c !== comment);
    this.save();
  }

  private ownComment(commentId: string): TaskComment {
    const comment = this.state.taskComments.find((c) => c.id === commentId);
    if (!comment) throw new MockError(404, "not_found", "找不到這則留言");
    if (comment.authorMemberId !== ME_ID) {
      throw new MockError(403, "forbidden", "只能修改自己的留言");
    }
    return comment;
  }

  /**
   * 記下文字中新出現的 mention；@agent 建立 `consult` Run（有保留 Worktree 的主 Run 時唯讀讀它），
   * 回傳建立的 Run。
   */
  consultForMentions(
    task: Task,
    text: string,
    sourceKind: Mention["sourceKind"],
    sourceId: string,
    nodeIds: string[] = [],
  ): string[] {
    const created: string[] = [];
    const matches = parseMentions(text);
    const targets =
      sourceKind === "collab_document"
        ? matches.map((m, i) => ({
            target: m.target,
            nodeId: nodeIds[i] ?? formatMentionTargetId(m.target),
          }))
        : matches.map((m) => ({ target: m.target, nodeId: formatMentionTargetId(m.target) }));
    for (const { target, nodeId } of targets) {
      const exists = this.state.mentions.some(
        (m) => m.sourceKind === sourceKind && m.sourceId === sourceId && m.nodeId === nodeId,
      );
      if (exists) continue;
      let consultRunId: string | null = null;
      if (target.type === "agent") {
        consultRunId = this.startConsult(task, target.agent).id;
        created.push(consultRunId);
      }
      this.state.mentions.push({
        id: this.newId("mention"),
        sourceKind,
        sourceId,
        nodeId,
        target,
        consultRunId,
        createdAt: now(),
      });
    }
    return created;
  }

  private startConsult(task: Task, agent: string): Run {
    const main = this.state.runs.findLast(
      (r) => r.taskId === task.id && r.parentRunId === null && r.worktreePath !== null,
    );
    const run = this.newRun(task.id, this.newId("run"), {
      agent,
      model: null,
      runnerKind: "local",
      permissionPolicy: "auto",
    });
    Object.assign(run, {
      origin: "mention",
      consultOfRunId: main?.id ?? null,
      runnerId: "runner-local",
    });
    this.state.runs.push(run);
    this.state.events[run.id] = [];
    const say = (text: string): ScriptStep => ({
      type: "event",
      event: { kind: "message_chunk", content: { type: "text", text } },
    });
    this.state.simulations[run.id] = {
      queue: [
        {
          type: "event",
          event: { kind: "status_changed", status: "running", gate: null, message: null },
        },
        say("我看了一下這個 Task。"),
        {
          type: "event",
          event: { kind: "status_changed", status: "completed", gate: null, message: null },
        },
      ],
      waiting: null,
    };
    return run;
  }

  /** @agent 的 consult Run 結束後，Agent 的回覆貼回成一則留言（作者是那個 Run）。 */
  private replyFromConsult(run: Run): void {
    const time = now();
    this.state.taskComments.push({
      id: this.newId("comment"),
      taskId: run.taskId,
      authorMemberId: null,
      authorRunId: run.id,
      body: `${run.agent} 的回覆：README 可以再補上使用範例。`,
      consultRunIds: [],
      createdAt: time,
      updatedAt: time,
    });
  }

  // ---------- Draft Task（ARCHITECTURE §9；Agent 以 propose_tasks 提出） ----------

  private seedDraftTasks(run: Run): void {
    const time = now();
    const draft = (
      position: number,
      title: string,
      acceptanceCriteria: DraftTask["acceptanceCriteria"],
      dependsOn: string[],
    ): DraftTask => ({
      id: `draft-${position}`,
      projectId: "project-1",
      batchId: "batch-1",
      position,
      proposedByRunId: run.id,
      repoId: "repo-1",
      spec: "docs/specs/login.md",
      title,
      description: `${title}（由 Agent 依 Spec 拆出）`,
      acceptanceCriteria,
      dependsOn,
      createdAt: time,
      updatedAt: time,
    });
    this.state.draftTasks = [
      draft(
        1,
        "建立登入 API",
        [
          { kind: "command", description: "API 測試通過", command: "pnpm test" },
          { kind: "agent", description: "API 文件符合 Spec", command: null },
        ],
        [],
      ),
      draft(2, "登入頁 UI", [{ kind: "browser", description: "可以登入", command: null }], ["#1"]),
      draft(
        3,
        "登入流程的 e2e",
        [{ kind: "command", description: "e2e 通過", command: null }],
        ["#2", "ORB-1"],
      ),
    ];
  }

  draftTasks(projectId: string): DraftTask[] {
    this.project(projectId);
    return this.state.draftTasks
      .filter((d) => d.projectId === projectId)
      .sort((a, b) => a.batchId.localeCompare(b.batchId) || a.position - b.position);
  }

  private draftTask(id: string): DraftTask {
    const draft = this.state.draftTasks.find((d) => d.id === id);
    if (!draft) throw new MockError(404, "not_found", "找不到這個 Draft Task");
    return draft;
  }

  updateDraftTask(id: string, input: UpdateDraftTaskInput): DraftTask {
    this.requireEditor();
    const draft = this.draftTask(id);
    Object.assign(draft, input, { updatedAt: now() });
    this.save();
    return draft;
  }

  /** 確認一個 Draft Task：建立 Task（Backlog）與 Acceptance Criterion，同批指向它的 `#n` 改寫成 Task Key。 */
  private confirmOne(draft: DraftTask): Task {
    const dependsOn = draft.dependsOn.map((dep) => {
      if (dep.startsWith("#")) {
        throw new MockError(409, "conflict", `「${draft.title}」依賴的 Draft Task ${dep} 還沒確認`);
      }
      const target = this.state.tasks.find((t) => t.key === dep);
      if (!target) throw new MockError(422, "invalid_input", `找不到 Task ${dep}`);
      return target.id;
    });
    if (draft.repoId === null) {
      throw new MockError(422, "invalid_input", `「${draft.title}」還沒有指定 Repo`);
    }
    const task = this.createTask(draft.projectId, {
      repoId: draft.repoId,
      title: draft.title,
      description: draft.description,
      dependsOn,
    });
    task.createdByMemberId = null;
    for (const criterion of draft.acceptanceCriteria) {
      this.createAcceptanceCriterion(task.id, criterion);
    }
    this.removeDraft(draft, task.key);
    return task;
  }

  /** 移除 Draft Task；同批其他草稿指向它的 `#n` 改寫成 `replacement`，沒有時直接移除。 */
  private removeDraft(draft: DraftTask, replacement: string | null): void {
    this.state.draftTasks = this.state.draftTasks.filter((d) => d.id !== draft.id);
    const ref = `#${draft.position}`;
    for (const other of this.state.draftTasks) {
      if (other.batchId !== draft.batchId || !other.dependsOn.includes(ref)) continue;
      other.dependsOn = replacement
        ? other.dependsOn.map((d) => (d === ref ? replacement : d))
        : other.dependsOn.filter((d) => d !== ref);
    }
  }

  confirmDraftTask(id: string): Task {
    this.requireEditor();
    const task = this.confirmOne(this.draftTask(id));
    this.save();
    return task;
  }

  dismissDraftTask(id: string): void {
    this.requireEditor();
    this.removeDraft(this.draftTask(id), null);
    this.save();
  }

  /** 批次確認：依相依順序建立（被依賴的先）。依賴的草稿不在這一批又還沒確認時回 409，整批不建立。 */
  confirmDraftTasks(projectId: string, ids: string[]): { draftTaskId: string; task: Task }[] {
    this.requireEditor();
    const drafts = ids.map((id) => this.draftTask(id));
    if (drafts.some((d) => d.projectId !== projectId)) {
      throw new MockError(404, "not_found", "Draft Task 不在這個 Project");
    }
    const selected = new Set(drafts.map((d) => `${d.batchId}#${d.position}`));
    for (const draft of drafts) {
      for (const dep of draft.dependsOn) {
        if (dep.startsWith("#") && !selected.has(`${draft.batchId}${dep}`)) {
          throw new MockError(
            409,
            "conflict",
            `「${draft.title}」依賴的 Draft Task ${dep} 還沒確認`,
          );
        }
      }
    }
    const created = new Map<string, Task>();
    let remaining = [...drafts];
    while (remaining.length > 0) {
      const ready = remaining.filter((d) => !d.dependsOn.some((dep) => dep.startsWith("#")));
      if (ready.length === 0) throw new MockError(409, "conflict", "Draft Task 的相依關係有循環");
      for (const draft of ready) created.set(draft.id, this.confirmOne(draft));
      remaining = remaining.filter((d) => !created.has(d.id));
    }
    this.save();
    return ids.map((id) => ({ draftTaskId: id, task: created.get(id) as Task }));
  }

  dismissDraftTasks(projectId: string, ids: string[]): void {
    this.requireEditor();
    for (const draft of ids.map((id) => this.draftTask(id))) {
      if (draft.projectId !== projectId) {
        throw new MockError(404, "not_found", "Draft Task 不在這個 Project");
      }
      this.removeDraft(draft, null);
    }
    this.save();
  }

  // ---------- Verification（ARCHITECTURE §5.1；真實系統中由 Server 發起） ----------

  verifications(runId: string): Verification[] {
    this.run(runId);
    return this.state.verifications.filter((v) => v.runId === runId);
  }

  /** Verification 超過重試上限後人的決定。 */
  decideVerification(runId: string, input: VerificationDecisionInput): void {
    this.requireEditor();
    const run = this.run(runId);
    if (input.action === "skip" && !this.mayApprove(this.task(run.taskId))) {
      throw new MockError(403, "forbidden", "略過失敗進入 Review Gate 需要核准 Gate 的權限");
    }
    const latest = this.verifications(runId).at(-1);
    if (!latest?.awaitingDecision) {
      throw new MockError(409, "conflict", "這個 Run 沒有在等待 Verification 的決定");
    }
    Object.assign(latest, {
      awaitingDecision: false,
      resolution: input.action,
      resolvedByMemberId: ME_ID,
      comment: input.action === "retry" ? (input.comment ?? null) : null,
    });
    this.state.needsYou = this.state.needsYou.filter(
      (i) => !(i.kind === "stopped_run" && i.runId === runId),
    );
    const task = this.task(run.taskId);
    if (input.action === "retry") {
      const reason = latest.results
        .filter((r) => r.outcome !== "passed")
        .map((r) => r.summary)
        .join("\n");
      this.state.simulations[runId] = {
        queue: [
          {
            type: "event",
            event: {
              kind: "prompt_submitted",
              source: "verification_retry",
              prompt: [{ type: "text", text: [input.comment, reason].filter(Boolean).join("\n") }],
            },
          },
          ...verificationFixTurn(),
        ],
        waiting: null,
      };
    } else if (input.action === "skip") {
      this.createGate(run, task, "review");
    } else {
      this.cancelRun(runId);
    }
    task.updatedAt = now();
    this.save();
  }

  /** 在 Review Gate 為 `manual` 條件打勾或取消。 */
  checkAcceptanceCriterion(criterionId: string, checked: boolean): AcceptanceCriterion {
    this.requireEditor();
    const criterion = this.state.acceptanceCriteria.find((c) => c.id === criterionId);
    if (!criterion) throw new MockError(404, "not_found", "找不到這條 Acceptance Criterion");
    // 同 Server：打勾需要核准 Gate 的權限
    if (!this.mayApprove(this.task(criterion.taskId))) {
      throw new MockError(403, "forbidden", "沒有核准這個 Gate 的權限");
    }
    if (criterion.kind !== "manual") {
      throw new MockError(422, "invalid_input", "只有 manual 類型的條件可以打勾");
    }
    const pending = this.state.gates.some(
      (g) => g.taskId === criterion.taskId && g.kind === "review" && g.decision === null,
    );
    if (!pending) throw new MockError(409, "conflict", "只能在 Review Gate 中打勾");
    const time = now();
    Object.assign(criterion, {
      result: checked ? "passed" : "pending",
      resultUpdatedAt: checked ? time : null,
      resultSummary: null,
      checkedByMemberId: checked ? ME_ID : null,
      updatedAt: time,
    });
    this.save();
    return criterion;
  }

  /** 送 verify：列出非 manual 的條件，依 `verificationFailures` 決定這一輪的 command 條件是否失敗。 */
  private startVerification(run: Run, task: Task): void {
    const criteria = this.acceptanceCriteria(task.id).filter((c) => c.kind !== "manual");
    const previous = this.verifications(run.id).at(-1);
    // 連續失敗才累加；通過、人選擇再試或略過之後從 1 重新算
    const attempt =
      previous && previous.resolution === null && previous.status !== "passed"
        ? previous.attempt + 1
        : 1;
    const round = (this.state.verificationRounds[run.id] ?? 0) + 1;
    this.state.verificationRounds[run.id] = round;
    const fail = round <= (this.config.verificationFailures ?? 0);
    const verification: Verification = {
      id: this.newId("verification"),
      runId: run.id,
      taskId: task.id,
      attempt,
      status: "running",
      resolution: null,
      resolvedByMemberId: null,
      comment: null,
      awaitingDecision: false,
      results: [],
      startedAt: now(),
      completedAt: null,
    };
    this.state.verifications.push(verification);
    task.status = "verifying";
    const steps: EventKind[] = [
      { kind: "status_changed", status: "verifying", gate: null, message: null },
    ];
    for (const criterion of criteria) {
      const failed = fail && criterion.kind === "command";
      let judgedBy: string | null = null;
      if (criterion.kind !== "command") {
        // agent／browser 以 consult Child Run 判定（§5.1）
        const child = this.newRun(task.id, this.newId("run"), {
          agent: "claude-code",
          model: "claude-sonnet-5-5",
          runnerKind: run.runnerKind,
          permissionPolicy: run.permissionPolicy,
        });
        Object.assign(child, {
          parentRunId: run.id,
          delegationMode: "consult",
          origin: "verification",
          startedByMemberId: null,
          runnerId: run.runnerId,
          status: "completed",
          startedAt: now(),
          endedAt: now(),
        });
        this.state.runs.push(child);
        this.state.events[child.id] = [];
        judgedBy = child.id;
      }
      steps.push({
        kind: "verification_result",
        verification_id: verification.id,
        attempt,
        criterion_id: criterion.id,
        outcome: failed ? "failed" : "passed",
        summary: failed
          ? `${criterion.command ?? "pnpm test"} 失敗：exit code 1`
          : `${criterion.description}：通過`,
        evidence: this.evidenceFor(criterion, failed),
        judged_by_run_id: judgedBy,
      });
    }
    steps.push(
      {
        kind: "verification_completed",
        verification_id: verification.id,
        attempt,
        outcome: fail && criteria.some((c) => c.kind === "command") ? "failed" : "passed",
      },
      { kind: "status_changed", status: "awaiting_gate", gate: "review", message: null },
    );
    const simulation = this.state.simulations[run.id] ?? { queue: [], waiting: null };
    simulation.queue.unshift(...steps.map((event): ScriptStep => ({ type: "event", event })));
    this.state.simulations[run.id] = simulation;
  }

  private evidenceFor(criterion: AcceptanceCriterion, failed: boolean): VerificationEvidence[] {
    switch (criterion.kind) {
      case "command":
        return [
          {
            type: "command_output",
            command: criterion.command ?? "pnpm test",
            exit_code: failed ? 1 : 0,
            output: {
              type: "inline",
              text: failed ? "✗ 1 個測試失敗：hello.txt 不存在\n" : "✓ 3 個測試通過\n",
            },
            truncated: false,
          },
        ];
      case "agent":
        return [{ type: "text", text: "Agent 判定：diff 符合 Spec 的描述。" }];
      case "browser": {
        const blobId = this.newId("blob");
        this.state.blobs[blobId] = SCREENSHOT_DATA_URL;
        return [
          {
            type: "screenshot",
            image: {
              blob_id: blobId,
              sha256: "0".repeat(64),
              size: 68,
              media_type: "image/png",
            },
            caption: "首頁",
            url: "http://localhost:4123/",
          },
          { type: "action_log", steps: ["開啟首頁", "點擊「開始」", "看到歡迎訊息"] },
        ];
      }
      default:
        return [];
    }
  }

  /** Verification 的一輪結束（Server 收到 verification_completed）：通過就進 Review Gate，失敗就重試或等人決定。 */
  private finishVerification(run: Run, task: Task, verificationId: string, outcome: string): void {
    const verification = this.state.verifications.find((v) => v.id === verificationId);
    if (!verification) return;
    verification.status =
      outcome === "passed" ? "passed" : outcome === "error" ? "error" : "failed";
    verification.completedAt = now();
    this.state.verificationPhase[run.id] = "done";
    if (verification.status === "passed") {
      this.createGate(run, task, "review");
      return;
    }
    const maxRetries = this.project(task.projectId).policy.verificationMaxRetries;
    if (verification.attempt <= maxRetries) {
      const reason = verification.results
        .filter((r) => r.outcome !== "passed")
        .map((r) => r.summary)
        .join("\n");
      const simulation = this.state.simulations[run.id] ?? { queue: [], waiting: null };
      simulation.queue.push(
        {
          type: "event",
          event: {
            kind: "prompt_submitted",
            source: "verification_retry",
            prompt: [{ type: "text", text: reason }],
          },
        },
        ...verificationFixTurn(),
      );
      this.state.simulations[run.id] = simulation;
      return;
    }
    verification.awaitingDecision = true;
    this.notify("verification_failed", `${task.key} 的 Verification 連續失敗`, {
      taskId: task.id,
      taskKey: task.key,
      runId: run.id,
      url: `/runs/${run.id}`,
    });
    this.state.needsYou.push({
      id: this.newId("needs-you"),
      kind: "stopped_run",
      reason: `Verification 連續失敗 ${verification.attempt} 輪，超過重試上限`,
      memberId: ME_ID,
      taskId: task.id,
      taskKey: task.key,
      runId: run.id,
      createdAt: now(),
    });
  }

  /** 建立等待決定的 Gate，並加入 Needs You。 */
  private createGate(run: Run, task: Task, kind: GateKind): void {
    const planSeq =
      kind === "plan"
        ? ((this.state.events[run.id] ?? []).findLast((e) => e.event.kind === "plan_proposed")
            ?.seq ?? null)
        : null;
    const reviewDiffSeq =
      kind === "review"
        ? ((this.state.events[run.id] ?? []).findLast((e) => e.event.kind === "run_diff")?.seq ??
          null)
        : null;
    task.status = kind === "plan" ? "plan_gate" : "review_gate";
    this.state.gates.push({
      id: this.newId("gate"),
      taskId: task.id,
      runId: run.id,
      kind,
      decision: null,
      decidedByMemberId: null,
      decidedAt: null,
      comment: null,
      reviewComments: [],
      previewComments: [],
      planSeq,
      reviewDiffSeq,
      finishedWithoutChanges: false,
      createdAt: now(),
    });
    this.notify(
      "gate_pending",
      `${task.key} 等待 ${kind === "plan" ? "Plan Gate" : "Review Gate"}`,
      {
        taskId: task.id,
        taskKey: task.key,
        runId: run.id,
        url: kind === "plan" ? `/runs/${run.id}` : `/runs/${run.id}/review`,
      },
    );
    this.state.needsYou.push({
      id: this.newId("needs-you"),
      kind: "gate",
      gateKind: kind,
      memberId: ME_ID,
      taskId: task.id,
      taskKey: task.key,
      runId: run.id,
      createdAt: now(),
    });
  }

  cancelRun(runId: string): Run {
    this.requireEditor();
    const run = this.run(runId);
    this.cancelTree(run);
    // 頂層的 Run 被中止後 Task 回到 Ready，可以重新派工（§5）；Child Run 被中止不影響 Task
    if (run.parentRunId === null && run.origin === "dispatch") {
      const task = this.task(run.taskId);
      task.status = "ready";
      task.updatedAt = now();
    }
    this.save();
    return run;
  }

  /** 中止 Run，連同還沒結束的 Child Run（§6.2「父 Run 被中止時連同 Child Run 一起處理」）。 */
  private cancelTree(run: Run): void {
    for (const child of this.state.runs.filter((r) => r.parentRunId === run.id)) {
      this.cancelTree(child);
    }
    if (["completed", "failed", "canceled"].includes(run.status)) return;
    delete this.state.simulations[run.id];
    this.state.needsYou = this.state.needsYou.filter(
      (i) => i.runId !== run.id && !(i.kind === "child_question" && i.childRunId === run.id),
    );
    this.append(run.id, [
      { kind: "status_changed", status: "canceled", gate: null, message: "已中止" },
    ]);
  }

  /** 人回答 Child Run 的 `ask_parent`（父 Run 的回合已經結束時，§9）。 */
  answerChildQuestion(questionId: string, answer: string): void {
    this.requireEditor();
    const item = this.state.needsYou.find(
      (i) => i.kind === "child_question" && i.questionId === questionId,
    );
    if (item?.kind !== "child_question") {
      throw new MockError(409, "conflict", "這個問題已經回答過了");
    }
    this.state.needsYou = this.state.needsYou.filter((i) => i !== item);
    this.append(item.childRunId, [
      {
        kind: "prompt_submitted",
        source: "child_question",
        prompt: [{ type: "text", text: answer }],
      },
      { kind: "status_changed", status: "running", gate: null, message: null },
    ]);
    this.save();
  }

  /**
   * `childRuns` 設定的種子：在等待 Review Gate 的 Run 底下建立 Child Run 樹——branch 模式的
   * Child Run（執行中，底下還有一層 consult）、已完成的 consult，以及一個向人提問的 Child Run。
   */
  private seedChildRuns(parent: Run): void {
    const child = (
      id: string,
      parentRun: Run,
      mode: "consult" | "branch",
      agent: string,
      status: Run["status"],
    ): Run => {
      const run = this.newRun(parentRun.taskId, id, {
        agent,
        model: agent === "codex" ? "gpt-5" : "claude-sonnet-5-5",
        runnerKind: parentRun.runnerKind,
        permissionPolicy: parentRun.permissionPolicy,
      });
      Object.assign(run, {
        parentRunId: parentRun.id,
        delegationMode: mode,
        origin: "delegation",
        startedByMemberId: null,
        runnerId: parentRun.runnerId,
      });
      this.state.runs.push(run);
      this.state.events[run.id] = [];
      this.append(run.id, [
        {
          kind: "worktree_ready",
          worktree_path: `C:/wt/demo/${id}`,
          branch: mode === "branch" ? `feature/${id}` : null,
          base_commit: BASE_COMMIT,
        },
        { kind: "status_changed", status: "running", gate: null, message: null },
        { kind: "message_chunk", content: { type: "text", text: `${id}：開始處理。` } },
      ]);
      if (status !== "running") {
        this.append(run.id, [
          { kind: "message_chunk", content: { type: "text", text: `${id}：完成了。` } },
          { kind: "status_changed", status, gate: null, message: null },
        ]);
      }
      return run;
    };
    const api = child("run-child-api", parent, "branch", "codex", "running");
    child("run-child-api-review", api, "consult", "claude-code", "completed");
    child("run-child-docs", parent, "consult", "claude-code", "completed");
    const asking = child("run-child-ask", parent, "consult", "antigravity", "running");
    const task = this.task(parent.taskId);
    this.state.needsYou.push({
      id: this.newId("needs-you"),
      kind: "child_question",
      memberId: ME_ID,
      taskId: task.id,
      taskKey: task.key,
      runId: parent.id,
      questionId: "question-1",
      childRunId: asking.id,
      question: "README 要用中文還是英文？",
      createdAt: now(),
    });
  }

  // ---------- Event 的副作用（真實系統中由 Server 處理） ----------

  // ---------- 工作區的後端缺口（U2，見 features/run/types.ts 的 TODO(backend, …)） ----------

  /** TODO(backend, run-prompt)：執行中傳訊息給 Agent，Agent 回覆後繼續原本的工作。 */
  submitPrompt(runId: string, text: string): void {
    this.requireEditor();
    const run = this.run(runId);
    if (["completed", "failed", "canceled"].includes(run.status)) {
      throw new MockError(409, "conflict", "Run 已經結束");
    }
    const simulation = this.state.simulations[runId] ?? { queue: [], waiting: null };
    this.state.simulations[runId] = simulation;
    this.append(runId, [
      { kind: "prompt_submitted", source: "user", prompt: [{ type: "text", text }] },
    ]);
    const seq = String(this.state.events[runId]?.length ?? 0);
    this.state.promptAuthors[runId] = { ...this.state.promptAuthors[runId], [seq]: ME_ID };
    simulation.queue.unshift({
      type: "event",
      event: {
        kind: "message_chunk",
        content: { type: "text", text: "收到，下一步照這個方向處理。" },
      },
    });
    this.save();
  }

  /** TODO(backend, run-settings)：目前的推理強度與切換紀錄。 */
  runSettings(runId: string): RunSettings {
    this.run(runId);
    return this.state.runSettings[runId] ?? { effort: "std", changes: [] };
  }

  /** TODO(backend, run-settings)：執行中切換模型（可以換 Agent）、推理強度、權限策略。 */
  updateRunSettings(runId: string, input: UpdateRunSettingsInput): RunSettings {
    this.requireEditor();
    const run = this.run(runId);
    if (["completed", "failed", "canceled"].includes(run.status)) {
      throw new MockError(409, "conflict", "Run 已經結束");
    }
    if (input.permissionPolicy === "yolo" && run.runnerKind === "team") {
      throw new MockError(422, "invalid_input", "Team Runner 不接受 yolo 的 Permission Policy");
    }
    const settings = this.runSettings(runId);
    const change = {
      ts: now(),
      memberId: ME_ID,
      agent: null,
      model: null,
      effort: null,
      permissionPolicy: null,
    };
    const changes = [...settings.changes];
    let effort: RunEffort | null = settings.effort;
    if (input.model !== undefined || input.agent !== undefined) {
      run.agent = input.agent ?? run.agent;
      run.model = input.model ?? run.model;
      changes.push({ ...change, kind: "model", agent: run.agent, model: run.model });
    }
    if (input.effort !== undefined) {
      effort = input.effort;
      changes.push({ ...change, kind: "effort", effort });
    }
    if (input.permissionPolicy !== undefined) {
      run.permissionPolicy = input.permissionPolicy;
      changes.push({ ...change, kind: "policy", permissionPolicy: input.permissionPolicy });
    }
    run.updatedAt = now();
    const next = { effort, changes };
    this.state.runSettings[runId] = next;
    this.save();
    return next;
  }

  /** TODO(backend, event-actor)：prompt 是誰送的、權限請求是誰回覆的。 */
  eventActors(runId: string): RunEventActors {
    const run = this.run(runId);
    const events = this.state.events[runId] ?? [];
    const prompts: Record<string, string> = { ...this.state.promptAuthors[runId] };
    const rejected = this.state.gates.filter(
      (g) => g.runId === runId && g.decision === "rejected" && g.decidedByMemberId !== null,
    );
    const counters: Record<string, number> = {};
    const permissions: Record<string, string> = {};
    for (const { seq, event } of events) {
      if (event.kind === "prompt_submitted") {
        const key = String(seq);
        if (prompts[key]) continue;
        if (event.source === "user" && run.startedByMemberId) prompts[key] = run.startedByMemberId;
        if (event.source === "plan_gate" || event.source === "review_gate") {
          const kind = event.source === "plan_gate" ? "plan" : "review";
          const index = counters[kind] ?? 0;
          counters[kind] = index + 1;
          const gate = rejected.filter((g) => g.kind === kind)[index];
          if (gate?.decidedByMemberId) prompts[key] = gate.decidedByMemberId;
        }
      }
      // 假後端只有目前的使用者會回覆權限請求
      if (event.kind === "permission_resolved" && event.selected_option_id !== null) {
        permissions[event.request_id] = ME_ID;
      }
    }
    return { prompts, permissions };
  }

  /** TODO(backend, task-pull-request)：Review Gate 核准後開出的 PR。 */
  taskPullRequest(taskId: string): TaskPullRequest | null {
    const task = this.task(taskId);
    if (task.status !== "pr_open" && !(task.status === "done" && task.doneReason === "completed")) {
      return null;
    }
    const run = this.state.runs
      .filter((r) => r.taskId === taskId && r.parentRunId === null && r.status === "completed")
      .at(-1);
    if (!run) return null;
    const number = 100 + (Number(task.key.split("-")[1]) || 0);
    return {
      number,
      url: `https://github.com/acme/demo/pull/${number}`,
      state: task.status === "done" ? "merged" : "open",
      runId: run.id,
      openedAt: run.endedAt ?? run.updatedAt,
      mergedAt: task.status === "done" ? task.updatedAt : null,
    };
  }

  /** TODO(backend, board-summary)：看板每列的最新主 Run 與驗收進度。 */
  boardSummary(projectId: string): BoardSummaryItem[] {
    return this.tasks(projectId).map((task) => {
      const run = this.state.runs
        .filter((r) => r.taskId === task.id && r.parentRunId === null && r.origin !== "mention")
        .at(-1);
      const criteria = this.acceptanceCriteria(task.id);
      const gate = run
        ? ((this.state.events[run.id] ?? []).findLast((e) => e.event.kind === "status_changed")
            ?.event as Extract<EventKind, { kind: "status_changed" }> | undefined)
        : undefined;
      return {
        taskId: task.id,
        latestRun: run
          ? {
              id: run.id,
              status: run.status,
              gate: run.status === "awaiting_gate" ? (gate?.gate ?? null) : null,
              agent: run.agent,
            }
          : null,
        acceptance: {
          passed: criteria.filter((c) => c.result === "passed").length,
          failed: criteria.filter((c) => c.result === "failed").length,
          total: criteria.length,
        },
      };
    });
  }

  private append(runId: string, kinds: EventKind[]): void {
    const list = this.state.events[runId] ?? [];
    this.state.events[runId] = list;
    const run = this.run(runId);
    const appended = kinds.map((event) => {
      const runEvent: RunEvent = { runId, seq: list.length + 1, ts: now(), event };
      list.push(runEvent);
      this.applySideEffects(run, event);
      return runEvent;
    });
    for (const listener of this.listeners) listener(runId, appended);
  }

  private applySideEffects(run: Run, event: EventKind): void {
    const task = this.task(run.taskId);
    run.updatedAt = now();
    switch (event.kind) {
      case "worktree_ready":
        run.worktreePath = event.worktree_path;
        run.branch = event.branch;
        run.baseCommit = event.base_commit;
        return;
      case "status_changed":
        run.status = event.status;
        // Child Run 與 @agent 的 consult Run 的狀態不影響 Task
        if (run.parentRunId !== null || run.origin === "mention") {
          if (["completed", "failed", "canceled"].includes(event.status)) run.endedAt = now();
          if (event.status === "completed" && run.origin === "mention") this.replyFromConsult(run);
          return;
        }
        if (event.status === "running") {
          run.startedAt ??= now();
          if (task.status !== "planning") task.status = "running";
        }
        if (event.status === "verifying") task.status = "verifying";
        if (event.status === "awaiting_gate" && event.gate === "plan") {
          this.createGate(run, task, "plan");
          return;
        }
        if (["completed", "failed", "canceled"].includes(event.status)) run.endedAt = now();
        if (event.status === "awaiting_gate" && event.gate === "review") {
          if (this.state.verificationPhase[run.id] === "done") {
            // Verification 結束的回報；結果已在 verification_completed 處理
            delete this.state.verificationPhase[run.id];
            return;
          }
          const verifiable = this.acceptanceCriteria(task.id).some((c) => c.kind !== "manual");
          if (verifiable) {
            this.state.verificationPhase[run.id] = "running";
            this.startVerification(run, task);
          } else {
            this.createGate(run, task, "review");
          }
        }
        return;
      case "verification_result": {
        const verification = this.state.verifications.find((v) => v.id === event.verification_id);
        verification?.results.push({
          criterionId: event.criterion_id,
          outcome: event.outcome,
          summary: event.summary,
          evidence: event.evidence,
          judgedByRunId: event.judged_by_run_id,
          createdAt: now(),
        });
        const criterion = this.state.acceptanceCriteria.find((c) => c.id === event.criterion_id);
        if (criterion) {
          Object.assign(criterion, {
            result: event.outcome === "passed" ? "passed" : "failed",
            resultSummary: event.summary,
            resultUpdatedAt: now(),
            checkedByRunId: event.judged_by_run_id,
          });
        }
        return;
      }
      case "verification_completed":
        this.finishVerification(run, task, event.verification_id, event.outcome);
        return;
      case "permission_request":
        run.status = "awaiting_permission";
        this.state.needsYou.push({
          id: this.newId("needs-you"),
          kind: "permission_request",
          memberId: run.startedByMemberId ?? ME_ID,
          taskId: task.id,
          taskKey: task.key,
          runId: run.id,
          permissionRequestId: event.request_id,
          toolCallId: event.tool_call_id,
          title: event.title,
          purpose: event.purpose,
          options: event.options.map((o) => ({
            optionId: o.option_id,
            name: o.name,
            kind: o.kind,
          })),
          createdAt: now(),
        });
        return;
      case "permission_resolved":
        run.status = "running";
        this.state.needsYou = this.state.needsYou.filter(
          (i) =>
            !(
              i.kind === "permission_request" &&
              i.runId === run.id &&
              i.permissionRequestId === event.request_id
            ),
        );
        return;
      case "usage":
        run.usage = {
          inputTokens: event.input_tokens,
          outputTokens: event.output_tokens,
          thoughtTokens: event.thought_tokens,
          cachedReadTokens: event.cached_read_tokens,
          cachedWriteTokens: event.cached_write_tokens,
          contextUsedTokens: event.context_used_tokens,
          contextWindowTokens: event.context_window_tokens,
          cost: event.cost,
        };
        return;
      default:
        return;
    }
  }
}

function member(id: string, githubUserId: number, login: string, name: string, role: Role): Member {
  return {
    id,
    teamId: "team-1",
    githubUserId,
    githubLogin: login,
    name,
    avatarUrl: null,
    role,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
  };
}
