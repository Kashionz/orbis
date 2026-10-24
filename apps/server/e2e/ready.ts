// e2e:stack（scripts/system-e2e-stack.ts）就緒時在 stdout 印的那一行 JSON。欄位說明見 README。

export interface ReadyLine {
  ready: true;
  serverUrl: string;
  webOrigin: string;
  sessionCookie: { name: string; value: string };
  teamId: string;
  memberId: string;
  projectId: string;
  projectKey: string;
  repoId: string;
  /** stack 自己啟動的 Runner；`--runner-config-out` 模式下不啟動 Runner，兩者都是 null。 */
  runnerId: string | null;
  runnerPid: number | null;
  /**
   * Delegation e2e 用的第二個 Agent（Agent Profile 的 id）：有設定 `<前綴>E2E_CHILD_AGENT_SCRIPT` 時，
   * runner.toml 多註冊這個 Agent（同一個 Fake Agent 執行檔、另一份劇本）；沒有時為 null。
   */
  childAgent: string | null;
  /**
   * Runner 的本機目錄（ORBIS_HOME），`runner.toml` 在它底下。自己啟動 Runner 時在 tempDir 中；
   * `--runner-config-out` 模式下是指定的目錄。
   */
  runnerHome: string;
  /** `runner.toml` 的完整路徑（`<runnerHome>/<NAMES.runnerConfigFile>`）。 */
  runnerConfigPath: string;
  bareRepoPath: string;
  checkoutPath: string;
  /** stack 使用的資料庫（e2e 的 helper 以它查出 PR 的對應）。 */
  databaseUrl: string;
  /** GitHub App 整合（連 GitHub 的部分是 in-memory 的 fake）。 */
  github: {
    /** webhook 的網址（`<serverUrl><API_ROUTES.githubWebhook>`）。 */
    webhookUrl: string;
    /** 這次執行隨機產生的 webhook secret。 */
    webhookSecret: string;
    /** 種子資料的 Repo 在 GitHub 上的資訊（App 已安裝）。 */
    repo: { owner: string; name: string; id: number; installationId: number };
  };
  tempDir: string;
}

/** 從 stack 的 stdout 中解析 ready 行。 */
export function parseReadyLine(line: string): ReadyLine {
  const value = JSON.parse(line) as Partial<ReadyLine>;
  if (value.ready !== true) throw new Error(`不是 e2e stack 的 ready 行：${line}`);
  return value as ReadyLine;
}

// ---- stdin 指令通道 ----
// ready 之後，stack 從 stdin 讀「每行一個 JSON」的指令，在 stdout 回一行 StackReply（以 `id` 對應）。
// FakeGitHub 活在 stack 的程序中，e2e 要餵它資料（例如 PR head 的 CI 結果）只能經由這條通道。
// 關閉 stdin 仍然代表結束 stack。

/** 餵給 FakeGitHub 的 check run（欄位對應 GitHubCheckRun，省略的用預設值）。 */
export interface SeededCheckRun {
  id: number;
  name: string;
  /** `success`、`failure`、`timed_out`、`cancelled`…；預設 `success`。 */
  conclusion?: string | null;
  /** 預設 `completed`。 */
  status?: string;
  /** 預設 `github-actions`。 */
  appSlug?: string;
  htmlUrl?: string;
  outputTitle?: string | null;
  outputSummary?: string | null;
}

/** 餵給 FakeGitHub 的 check suite；省略時由 check run 推出一個 `github-actions` 的 suite。 */
export interface SeededCheckSuite {
  id: number;
  appSlug: string;
  status: string;
  conclusion: string | null;
  latestCheckRunsCount: number;
}

export type StackCommand =
  /** 設定某個 commit 在 FakeGitHub 上的 check suite 與 check run（Feedback Loop 的 CI 路徑）。 */
  | {
      id: string;
      command: "seed_checks";
      sha: string;
      runs: SeededCheckRun[];
      suites?: SeededCheckSuite[];
    }
  /** 設定某個 GitHub 帳號對種子 Repo 的角色（`admin`、`write`、`read`、`none`…）。 */
  | {
      id: string;
      command: "set_github_role";
      user: { id: number; login: string; type?: "User" | "Bot" };
      role: string;
    }
  /** 列出 FakeGitHub 上某個 Issue 或 PR 的留言（例如 Feedback Loop 在 PR 上的紀錄留言）。 */
  | { id: string; command: "list_issue_comments"; number: number };

export interface StackReply {
  reply: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** stdout 的一行是不是指令的回覆（ready 行與回覆都走 stdout，其他 log 走 stderr）。 */
export function parseStackReply(line: string): StackReply | null {
  try {
    const value = JSON.parse(line) as Partial<StackReply>;
    return typeof value.reply === "string" && typeof value.ok === "boolean"
      ? (value as StackReply)
      : null;
  } catch {
    return null;
  }
}
