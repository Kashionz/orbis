// DomainService 的 fake：in-memory 的 Task、Repo、Member，並記錄每一次寫入，
// 讓測試可以斷言「沒有重複寫入」。

import type { TaskStatus } from "@orbis/api-contract";
import type {
  AcceptanceCriterionRecord,
  DomainService,
  GitHubNotificationKind,
  Logger,
  MemberRecord,
  Notifier,
  RepoRecord,
  RunSummary,
  TaskFieldsPatch,
  TaskRecord,
  TransitionCause,
  TransitionResult,
} from "../ports";
/** FakeDomainService 用到的時鐘：測試用 TestClock，dev harness 用真實時間。 */
export interface DomainClock {
  now(): Date;
  advance(ms: number): Date;
}

const clone = <T>(value: T): T => structuredClone(value);

export interface RecordedTransition {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  cause: TransitionCause;
  result: TransitionResult["ok"];
}

export class FakeDomainService implements DomainService {
  readonly tasks = new Map<string, TaskRecord>();
  readonly repos = new Map<string, RepoRecord>();
  readonly members = new Map<string, MemberRecord & { projectIds: string[] }>();
  readonly criteria = new Map<string, AcceptanceCriterionRecord[]>();
  readonly runs = new Map<string, RunSummary>();

  /** 所有從 GitHub 寫回 Task 欄位的呼叫。 */
  readonly fieldUpdates: { taskId: string; patch: TaskFieldsPatch }[] = [];
  readonly transitions: RecordedTransition[] = [];
  readonly createdFromIssue: TaskRecord[] = [];
  readonly repoUpdates: { repoId: string; info: object }[] = [];
  /** 有進行中 Run 的 Task：轉 Done 會被拒絕。 */
  readonly activeRunTaskIds = new Set<string>();
  /** 狀態機不允許的轉換（`from->to`）。 */
  readonly forbiddenTransitions = new Set<string>();
  /** 關閉「自動建立 Issue」的 Project。 */
  readonly autoCreateDisabledProjectIds = new Set<string>();
  #nextTask = 1;
  #failures = new Set<keyof DomainService>();

  constructor(readonly clock: DomainClock) {}

  /** 讓下一次呼叫 `method` 丟出錯誤（例如資料庫暫時連不上）。 */
  failNext(method: keyof DomainService): void {
    this.#failures.add(method);
  }

  #maybeFail(method: keyof DomainService): void {
    if (this.#failures.delete(method)) throw new Error(`${method} 暫時失敗`);
  }

  addRepo(repo: RepoRecord): RepoRecord {
    this.repos.set(repo.id, clone(repo));
    return repo;
  }

  addMember(member: MemberRecord, projectIds: string[]): MemberRecord {
    this.members.set(member.id, { ...member, projectIds });
    return member;
  }

  addTask(task: Partial<TaskRecord> & Pick<TaskRecord, "projectId" | "title">): TaskRecord {
    const number = this.#nextTask++;
    const full: TaskRecord = {
      id: `task-${number}`,
      key: `ORB-${number}`,
      repoId: null,
      description: "",
      status: "backlog",
      assigneeMemberId: null,
      createdByMemberId: null,
      labels: [],
      specPath: null,
      updatedAt: this.clock.now(),
      ...task,
      doneReason: task.doneReason ?? null,
    };
    this.tasks.set(full.id, clone(full));
    return clone(full);
  }

  /** 模擬有人在 Orbis 上修改 Task（Server 之後會呼叫 onTaskChanged）。 */
  editTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord {
    const task = this.#task(taskId);
    this.clock.advance(1000);
    Object.assign(task, clone(patch), { updatedAt: this.clock.now() });
    return clone(task);
  }

  repo(repoId: string): RepoRecord {
    const repo = this.repos.get(repoId);
    if (!repo) throw new Error(`沒有 Repo ${repoId}`);
    return clone(repo);
  }

  task(taskId: string): TaskRecord {
    return clone(this.#task(taskId));
  }

  #task(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`沒有 Task ${taskId}`);
    return task;
  }

  // ── DomainService ─────────────────────────────────────────────

  async getTask(taskId: string) {
    const task = this.tasks.get(taskId);
    return task ? clone(task) : null;
  }

  async getRepo(repoId: string) {
    const repo = this.repos.get(repoId);
    return repo ? clone(repo) : null;
  }

  async listReposByGithubRepoId(githubRepoId: number) {
    return [...this.repos.values()].filter((r) => r.githubRepoId === githubRepoId).map(clone);
  }

  async listReposByInstallationId(installationId: number) {
    return [...this.repos.values()].filter((r) => r.installationId === installationId).map(clone);
  }

  async updateRepoGitHubInfo(
    repoId: string,
    info: { installationId?: number | null; githubRepoId?: number; defaultBranch?: string },
  ) {
    const repo = this.repos.get(repoId);
    if (!repo) throw new Error(`沒有 Repo ${repoId}`);
    Object.assign(repo, info);
    this.repoUpdates.push({ repoId, info: clone(info) });
  }

  async createTaskFromIssue(input: {
    repoId: string;
    title: string;
    description: string;
    labels: string[];
    assigneeMemberId: string | null;
    createdByMemberId: string;
  }) {
    const repo = this.repos.get(input.repoId);
    if (!repo) throw new Error(`沒有 Repo ${input.repoId}`);
    const task = this.addTask({ ...input, projectId: repo.projectId });
    this.createdFromIssue.push(task);
    return task;
  }

  async updateTaskFields(taskId: string, patch: TaskFieldsPatch) {
    this.#maybeFail("updateTaskFields");
    const task = this.#task(taskId);
    this.fieldUpdates.push({ taskId, patch: clone(patch) });
    Object.assign(task, clone(patch), { updatedAt: this.clock.now() });
    return clone(task);
  }

  async transitionTask(
    taskId: string,
    to: TaskStatus,
    cause: TransitionCause,
  ): Promise<TransitionResult> {
    const task = this.#task(taskId);
    const from = task.status;
    let result: TransitionResult;
    if (to === "done" && this.activeRunTaskIds.has(taskId)) {
      result = { ok: false, reason: "active_run" };
    } else if (this.forbiddenTransitions.has(`${from}->${to}`)) {
      result = { ok: false, reason: "invalid_transition" };
    } else {
      task.status = to;
      // 轉為 Done 時記錄關閉原因，離開 Done 時清空（ARCHITECTURE §11）
      task.doneReason = to === "done" && "doneReason" in cause ? cause.doneReason : null;
      task.updatedAt = this.clock.now();
      result = { ok: true, task: clone(task) };
    }
    this.transitions.push({ taskId, from, to, cause: clone(cause), result: result.ok });
    return result;
  }

  async listAcceptanceCriteria(taskId: string) {
    return clone(this.criteria.get(taskId) ?? []);
  }

  async getLatestRun(taskId: string) {
    const run = this.runs.get(taskId);
    return run ? clone(run) : null;
  }

  async getMember(memberId: string) {
    const member = this.members.get(memberId);
    if (!member) return null;
    const { projectIds: _ignored, ...record } = member;
    return record;
  }

  /** 不能編輯 Task 的 Member（例如 Viewer）。 */
  readonly viewerMemberIds = new Set<string>();

  async canEditTasks(_projectId: string, memberId: string) {
    return !this.viewerMemberIds.has(memberId);
  }

  async autoCreateIssues(projectId: string) {
    return !this.autoCreateDisabledProjectIds.has(projectId);
  }

  async findMemberByGithubUserId(projectId: string, githubUserId: number) {
    for (const member of this.members.values()) {
      if (member.githubUserId === githubUserId && member.projectIds.includes(projectId)) {
        const { projectIds: _ignored, ...record } = member;
        return record;
      }
    }
    return null;
  }
}

export interface RecordedNotification {
  memberId: string;
  kind: GitHubNotificationKind;
  taskId: string;
  message: string;
  url?: string;
}

export class RecordingNotifier implements Notifier {
  readonly sent: RecordedNotification[] = [];
  async notify(notification: RecordedNotification) {
    this.sent.push(clone(notification));
  }
}

/** 收集 log 的 Logger。 */
export class MemoryLogger implements Logger {
  readonly entries: { level: "info" | "warn" | "error"; obj: object; msg: string }[] = [];
  info(obj: object, msg: string) {
    this.entries.push({ level: "info", obj, msg });
  }
  warn(obj: object, msg: string) {
    this.entries.push({ level: "warn", obj, msg });
  }
  error(obj: object, msg: string) {
    this.entries.push({ level: "error", obj, msg });
  }
}
