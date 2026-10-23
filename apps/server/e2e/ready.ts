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
