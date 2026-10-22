// 手動驗證用的 dev harness：真實的 GitHub App ＋ in-memory 的 Task（FakeDomainService）。
// Server（B 軌）完成前，用它在測試 repo 上走過 Issue 雙向同步、開 PR、merge 後轉 Done。
//
//   pnpm --filter @orbis/github dev:harness --repo Kashionz/orbis-sandbox --member Kashionz:13392701 [--port 4402]
//
// webhook 用 smee.io 轉到本機：npx smee-client --url <channel> --target http://localhost:4402/api/webhooks/github
//
// 控制用的 API（JSON）：
//   GET   /dev/state                      Task、對應、狀態轉換、通知
//   POST  /dev/tasks                      { title, description?, labels?, assignee?(login), status? } 建立 Task 並同步
//   PATCH /dev/tasks/:id                  { title?, description?, labels?, assignee?, status? } 修改 Task 並同步
//   PUT   /dev/tasks/:id/criteria         [{ kind, description, result }] 設定 Acceptance Criterion 並同步
//   POST  /dev/tasks/:id/branch-pushed    { branch, commitSha } 模擬 Runner push 完成 → 開 PR
//   GET   /dev/importable-issues
//   POST  /dev/import                     { issueNumbers }

import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import type { TaskStatus } from "@orbis/api-contract";
import { Hono } from "hono";
import { loadGitHubAppConfig } from "../src/config";
import { createGitHubIntegration } from "../src/integration";
import type { AcceptanceCriterionRecord, TaskRecord } from "../src/ports";
import { createGitHubWebhookRoutes } from "../src/routes";
import {
  FakeDomainService,
  InMemoryGitHubStore,
  MemoryLogger,
  RecordingNotifier,
} from "../src/testing";
import { readEnvFile } from "./env-file";

const { values } = parseArgs({
  // pnpm 會把 `--` 原樣傳進來
  args: process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--")),
  options: {
    repo: { type: "string" },
    member: { type: "string", multiple: true, default: [] },
    port: { type: "string", default: "4402" },
  },
});
if (!values.repo?.includes("/")) throw new Error("請用 --repo <owner>/<name> 指定測試 repo");
const [owner = "", name = ""] = values.repo.split("/");

const config = loadGitHubAppConfig({ ...readEnvFile(), ...process.env });
if (!config) throw new Error("找不到 GitHub App 設定，請先執行 app:create");

const clock = {
  now: () => new Date(),
  advance: () => new Date(),
};
const PROJECT_ID = "dev-project";
const REPO_ID = "dev-repo";
const domain = new FakeDomainService(clock);
const store = new InMemoryGitHubStore();
const notifier = new RecordingNotifier();
const logger = new MemoryLogger();
const consoleLogger = {
  info: (obj: object, msg: string) => {
    logger.info(obj, msg);
    console.log(`[info] ${msg}`, JSON.stringify(obj));
  },
  warn: (obj: object, msg: string) => {
    logger.warn(obj, msg);
    console.warn(`[warn] ${msg}`, JSON.stringify(obj));
  },
  error: (obj: object, msg: string) => {
    logger.error(obj, msg);
    console.error(`[error] ${msg}`, obj);
  },
};

const port = Number(values.port);
const github = createGitHubIntegration({
  config,
  domain,
  store,
  notifier,
  logger: consoleLogger,
  taskUrl: (task) => `http://localhost:${port}/dev/tasks/${task.id}`,
});

// harness 的第一個 --member 視為登記 Repo 的人
const requester = values.member[0]?.split(":") ?? [];
domain.addMember(
  {
    id: `member-${requester[0]}`,
    githubUserId: Number(requester[1]),
    githubLogin: requester[0] ?? "",
  },
  [PROJECT_ID],
);
const inspection = await github.inspectRepo(owner, name, `member-${requester[0]}`);
if (!inspection.installed) {
  throw new Error(`App 沒有安裝在 ${values.repo}，請先安裝：${inspection.installUrl}`);
}
domain.addRepo({
  id: REPO_ID,
  projectId: PROJECT_ID,
  owner: inspection.owner,
  name: inspection.name,
  githubRepoId: inspection.githubRepoId,
  defaultBranch: inspection.defaultBranch,
  installationId: inspection.installationId,
});
for (const spec of values.member) {
  const [login = "", id = ""] = spec.split(":");
  domain.addMember({ id: `member-${login}`, githubUserId: Number(id), githubLogin: login }, [
    PROJECT_ID,
  ]);
}
console.log(`已連上 ${inspection.htmlUrl}（installation ${inspection.installationId}）`);

const memberIdOf = (login: string | null | undefined) =>
  login ? ([...domain.members.values()].find((m) => m.githubLogin === login)?.id ?? null) : null;

const app = new Hono();
app.route("/api/webhooks/github", createGitHubWebhookRoutes(github));

app.get("/dev/state", (c) =>
  c.json({
    tasks: [...domain.tasks.values()],
    issueLinks: [...store.issueLinks.values()],
    pullRequestLinks: [...store.pullRequestLinks.values()],
    transitions: domain.transitions,
    fieldUpdates: domain.fieldUpdates,
    notifications: notifier.sent,
    deliveries: Object.fromEntries(store.deliveries),
  }),
);

app.get("/dev/tasks/:id", (c) => c.json(domain.tasks.get(c.req.param("id")) ?? null));

interface TaskInput {
  title?: string;
  description?: string;
  labels?: string[];
  assignee?: string | null;
  status?: TaskStatus;
}

function patchOf(input: TaskInput): Partial<TaskRecord> {
  const patch: Partial<TaskRecord> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.labels !== undefined) patch.labels = input.labels;
  if (input.status !== undefined) patch.status = input.status;
  if (input.assignee !== undefined) patch.assigneeMemberId = memberIdOf(input.assignee);
  return patch;
}

app.post("/dev/tasks", async (c) => {
  const input = (await c.req.json()) as TaskInput;
  const task = domain.addTask({
    projectId: PROJECT_ID,
    repoId: REPO_ID,
    title: input.title ?? "dev Task",
    createdByMemberId: [...domain.members.keys()][0] ?? null,
    ...patchOf(input),
  });
  return c.json({ task, sync: await github.onTaskChanged(task.id) });
});

app.patch("/dev/tasks/:id", async (c) => {
  const task = domain.editTask(c.req.param("id"), patchOf((await c.req.json()) as TaskInput));
  return c.json({ task, sync: await github.onTaskChanged(task.id) });
});

app.put("/dev/tasks/:id/criteria", async (c) => {
  domain.criteria.set(c.req.param("id"), (await c.req.json()) as AcceptanceCriterionRecord[]);
  return c.json({ sync: await github.onTaskChanged(c.req.param("id")) });
});

app.post("/dev/tasks/:id/branch-pushed", async (c) => {
  const input = (await c.req.json()) as { branch: string; commitSha: string };
  const taskId = c.req.param("id");
  return c.json(await github.onBranchPushed({ taskId, runId: `dev-run-${taskId}`, ...input }));
});

app.get("/dev/importable-issues", async (c) => c.json(await github.listImportableIssues(REPO_ID)));

app.post("/dev/import", async (c) => {
  const input = (await c.req.json()) as { issueNumbers: number[] };
  const importer = [...domain.members.keys()][0] ?? "member-dev";
  return c.json(
    await github.importIssues({
      repoId: REPO_ID,
      issueNumbers: input.issueNumbers,
      importedByMemberId: importer,
    }),
  );
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`dev harness：http://localhost:${port}（webhook：/api/webhooks/github）`);
});
