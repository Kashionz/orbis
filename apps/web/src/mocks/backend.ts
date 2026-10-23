// MSW 假後端的狀態與行為：照 ARCHITECTURE 的規則推進 Task、Run 與 Needs You，
// Run 的 Event 由 scripts.ts 的劇本逐步產生。
//
// 狀態存在 sessionStorage，重新整理頁面後延續（Playwright 每個測試是新的 context，互不影響）。
// 這只是開發期間的鷹架；完成條件的 M1 路徑 e2e 跑在真實 Server + Runner + Fake Agent 上。

import {
  type AcceptanceCriterion,
  type ApiError,
  type CreateAcceptanceCriterionInput,
  type CreateRunInput,
  type CreateTaskInput,
  canTransitionManually,
  type DispatchOptions,
  formatTaskKey,
  type Gate,
  type GateDecisionInput,
  type Member,
  type MeResponse,
  type NeedsYouItem,
  type Project,
  READY_REQUIREMENTS,
  type Repo,
  type ReviewDiff,
  type Role,
  type Run,
  type RunEvent,
  type RunUsage,
  type Task,
  type TaskStatus,
  type UpdateAcceptanceCriterionInput,
  type UpdateTaskInput,
} from "@orbis/api-contract";
import type { EventKind, PermissionPurpose, RunDiff, RunDiffFile, TextBody } from "@orbis/protocol";
import { MOCK_STATE_STORAGE_KEY, type MockConfig, mockConfig } from "./config";
import {
  BASE_COMMIT,
  BASE_FILES,
  configTrustTurn,
  generateLargeRun,
  m1FirstTurn,
  m1RevisionTurn,
  type ScriptStep,
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
  /** blob 的內容（review diff 中放在 blob 的大檔）。 */
  blobs: Record<string, string>;
  nextId: number;
}

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

function now(): string {
  return new Date().toISOString();
}

type Listener = (runId: string, events: RunEvent[]) => void;

export class MockBackend {
  private state: MockState;
  private readonly listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private largeRun: RunEvent[] | null = null;

  constructor(
    readonly config: MockConfig = mockConfig(),
    private readonly storage: Storage | null = typeof sessionStorage === "undefined"
      ? null
      : sessionStorage,
  ) {
    this.state = this.load() ?? this.seed();
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

  /** 每個模擬中的 Run 前進一步。 */
  tick(): void {
    let changed = false;
    for (const [runId, simulation] of Object.entries(this.state.simulations)) {
      if (simulation.waiting) continue;
      const step = simulation.queue.shift();
      if (!step) continue;
      changed = true;
      if (step.type === "event") {
        // 進入 Review Gate 前，Runner 送出完整 diff（協定的 run_diff）
        const enteringReview =
          step.event.kind === "status_changed" &&
          step.event.status === "awaiting_gate" &&
          step.event.gate === "review";
        const diff: EventKind[] = enteringReview
          ? [{ kind: "run_diff", ...this.computeDiff(runId) }]
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
    this.dispatch(waiting.id, {
      agent: "claude-code",
      model: null,
      runnerKind: "local",
      permissionPolicy: "manual",
    });

    // 等待 Review Gate 的 Run（劇本跑完第一回合，允許權限請求）
    const review = seedTask("整理 README", "ready", { assigneeMemberId: "member-alice" });
    const reviewRun = this.dispatch(review.id, {
      agent: "claude-code",
      model: null,
      runnerKind: "local",
      permissionPolicy: "auto",
    });
    this.settle();
    this.respondToPermission(reviewRun.id, "perm-write-config", "allow");
    this.settle();

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
      const trustRun = this.dispatch(trust.id, {
        agent: "claude-code",
        model: null,
        runnerKind: "local",
        permissionPolicy: "auto",
      });
      this.state.simulations[trustRun.id] = {
        queue: configTrustTurn(`feature/${trust.key.toLowerCase()}`),
        waiting: null,
      };
    }

    this.settle();
    for (const run of this.state.runs) run.createdAt = SEED_TIME;
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
          : { id: ME_ID, teamId: "team-1", teamName: "核心團隊", role },
    };
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

  repos(projectId: string): Repo[] {
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
        online: true,
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
            id: "gemini-cli",
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

  /** 最新一份 review diff（最後一筆 run_diff Event），還沒有時 404。 */
  reviewDiff(runId: string): ReviewDiff {
    const latest = this.events(runId).findLast((e) => e.event.kind === "run_diff");
    const diff = latest?.event;
    if (latest === undefined || diff?.kind !== "run_diff") {
      throw new MockError(404, "not_found", "找不到 review diff");
    }
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
    };
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
      createdAt: time,
      startedAt: null,
      endedAt: null,
      updatedAt: time,
    };
  }

  /** 派工：建立 Run，Task 進入 Running（Planning 在 B1 是直接通過）。 */
  dispatch(taskId: string, input: CreateRunInput): Run {
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
    this.state.simulations[run.id] = {
      queue: m1FirstTurn(`feature/${task.key.toLowerCase()}`),
      waiting: null,
    };
    task.status = "running";
    task.updatedAt = now();
    this.save();
    return run;
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
    if (input.action === "approve" && !this.mayApprove(task)) {
      throw new MockError(403, "forbidden", "這個 Project 不允許核准指派給自己的 Task");
    }
    const runId = gate.runId ?? "";
    this.state.reviews[runId] = [...(this.state.reviews[runId] ?? []), input];
    const time = now();
    Object.assign(gate, {
      decision: input.action === "approve" ? "approved" : "rejected",
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
              createdAt: time,
              updatedAt: time,
            }))
          : [],
    });
    this.state.needsYou = this.state.needsYou.filter(
      (i) => !(i.kind === "gate" && i.runId === runId),
    );
    if (input.action === "reject") {
      this.state.simulations[runId] = { queue: m1RevisionTurn(), waiting: null };
    } else if (input.action === "approve") {
      this.append(runId, [
        { kind: "status_changed", status: "completed", gate: null, message: "Review Gate 核准" },
      ]);
      task.status = "pr_open";
    } else {
      this.cancelRun(runId);
    }
    task.updatedAt = now();
    this.save();
    return gate;
  }

  cancelRun(runId: string): Run {
    this.requireEditor();
    const run = this.run(runId);
    delete this.state.simulations[runId];
    this.state.needsYou = this.state.needsYou.filter((i) => i.runId !== run.id);
    this.append(runId, [
      { kind: "status_changed", status: "canceled", gate: null, message: "已中止" },
    ]);
    // Run 被中止後 Task 回到 Ready，可以重新派工（§5）
    const task = this.task(run.taskId);
    task.status = "ready";
    task.updatedAt = now();
    this.save();
    return run;
  }

  // ---------- Event 的副作用（真實系統中由 Server 處理） ----------

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
        if (event.status === "running") {
          run.startedAt ??= now();
          task.status = "running";
        }
        if (["completed", "failed", "canceled"].includes(event.status)) run.endedAt = now();
        if (event.status === "awaiting_gate" && event.gate === "review") {
          task.status = "review_gate";
          this.state.gates.push({
            id: this.newId("gate"),
            taskId: task.id,
            runId: run.id,
            kind: "review",
            decision: null,
            decidedByMemberId: null,
            decidedAt: null,
            comment: null,
            reviewComments: [],
            createdAt: now(),
          });
          this.state.needsYou.push({
            id: this.newId("needs-you"),
            kind: "gate",
            gateKind: "review",
            memberId: ME_ID,
            taskId: task.id,
            taskKey: task.key,
            runId: run.id,
            createdAt: now(),
          });
        }
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
