// 各資源的合法 fixture。測試以這些為基礎，改掉一個欄位做出不合法的版本。

import type {
  AcceptanceCriterion,
  NeedsYouItem,
  Project,
  Repo,
  Run,
  RunEvent,
  Task,
} from "../src/index";

const NOW = "2026-10-23T08:00:00.000Z";

export const project = {
  id: "0195f0a0-0000-7000-8000-000000000001",
  teamId: "0195f0a0-0000-7000-8000-000000000002",
  name: "看板與派工",
  keyPrefix: "ORB",
  description: "",
  policy: {
    planGateEnabled: true,
    delegationEnabled: true,
    delegationAgents: null,
    forbidSelfApproval: false,
    memberCanDispatchToTeamRunner: true,
  },
  createdAt: NOW,
  updatedAt: NOW,
} satisfies Project;

export const repo = {
  id: "0195f0a0-0000-7000-8000-000000000003",
  projectId: project.id,
  owner: "acme",
  name: "web-app",
  defaultBranch: "main",
  createdAt: NOW,
  updatedAt: NOW,
} satisfies Repo;

export const task = {
  id: "0195f0a0-0000-7000-8000-000000000004",
  key: "ORB-12",
  projectId: project.id,
  repoId: repo.id,
  title: "登入頁加上 GitHub 按鈕",
  description: "## 目標\n\n使用者可以用 GitHub 登入。",
  status: "backlog",
  assigneeMemberId: null,
  specPath: "docs/specs/login.md",
  dependsOn: ["0195f0a0-0000-7000-8000-000000000099"],
  planGateEnabled: null,
  createdByMemberId: "0195f0a0-0000-7000-8000-000000000005",
  createdAt: NOW,
  updatedAt: NOW,
} satisfies Task;

export const acceptanceCriterion = {
  id: "0195f0a0-0000-7000-8000-000000000006",
  taskId: task.id,
  kind: "command",
  description: "單元測試全部通過",
  command: "pnpm test",
  position: 0,
  result: "pending",
  resultUpdatedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
} satisfies AcceptanceCriterion;

export const run = {
  id: "0195f0a0-0000-7000-8000-000000000007",
  taskId: task.id,
  parentRunId: null,
  delegationMode: null,
  agent: "claude-code",
  model: "claude-opus-5-5",
  permissionPolicy: "auto",
  runnerKind: "local",
  runnerId: "0195f0a0-0000-7000-8000-000000000008",
  worktreePath: "C:\\wt\\ORB-12",
  branch: "feature/ORB-12",
  baseCommit: "f5b05a1c0ffee",
  status: "running",
  usage: {
    inputTokens: 1200,
    outputTokens: 340,
    thoughtTokens: null,
    cachedReadTokens: 800,
    cachedWriteTokens: null,
    contextUsedTokens: 15_000,
    contextWindowTokens: 200_000,
    cost: { amount: 0.02, currency: "USD" },
  },
  startedByMemberId: task.createdByMemberId,
  createdAt: NOW,
  startedAt: NOW,
  endedAt: null,
  updatedAt: NOW,
} satisfies Run;

export const childRun = {
  ...run,
  id: "0195f0a0-0000-7000-8000-000000000009",
  parentRunId: run.id,
  delegationMode: "consult",
  agent: "codex",
  startedByMemberId: null,
} satisfies Run;

export const runEvent = {
  runId: run.id,
  seq: 1,
  ts: NOW,
  event: { kind: "message_chunk", content: { type: "text", text: "開始處理" } },
} satisfies RunEvent;

const needsYouBase = {
  memberId: task.createdByMemberId,
  taskId: task.id,
  taskKey: task.key,
  runId: run.id,
  createdAt: NOW,
};

export const needsYouPermissionRequest = {
  ...needsYouBase,
  id: "0195f0a0-0000-7000-8000-00000000000a",
  kind: "permission_request",
  permissionRequestId: "perm-1",
  toolCallId: "call-1",
  title: "執行 `npm install -g pnpm`",
  options: [
    { optionId: "allow", name: "允許一次", kind: "allow_once" },
    { optionId: "reject", name: "拒絕", kind: "reject_once" },
  ],
} satisfies NeedsYouItem;

export const needsYouGate = {
  ...needsYouBase,
  id: "0195f0a0-0000-7000-8000-00000000000b",
  kind: "gate",
  gateKind: "review",
} satisfies NeedsYouItem;

export const needsYouStoppedRun = {
  ...needsYouBase,
  id: "0195f0a0-0000-7000-8000-00000000000c",
  kind: "stopped_run",
  reason: "Verification 失敗 3 次",
} satisfies NeedsYouItem;
