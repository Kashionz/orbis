import type * as protocol from "@orbis/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  AddTaskShareMembersInput,
  AgentCatalogResponse,
  AgentSwitchRequested,
  API_ERROR_CODES,
  API_ROUTES,
  API_VERSION,
  ApiError,
  BoardSummaryResponse,
  ConnectRepoToGithubInput,
  CreatePreviewInviteInput,
  CreateRepoInput,
  CreateRunInput,
  CreateRunPromptInput,
  CreateTaskInviteInput,
  CreateTerminalInput,
  type Effort,
  type EffortSupport,
  LocalRepoName,
  MeResponse,
  NeedsYouItem,
  Notification,
  PreviewInvite,
  PreviewInviteCreated,
  Project,
  type PromptDelivery,
  Repo,
  type RepoKind,
  RepoSpecCommitResponse,
  RunEvent,
  RunPromptCreated,
  RunSettings,
  RunSettingsUpdated,
  STOPPED_RUN_REASONS,
  SwitchAgentInput,
  Task,
  TaskInviteCreated,
  TaskShare,
  Team,
  TerminalClientMessage,
  TerminalCreated,
  TerminalServerMessage,
  UpdateGeneralAccessInput,
  UpdateRunSettingsInput,
  UpdateTaskShareMemberInput,
  UpdateTeamInput,
} from "../src/index";
import * as fixtures from "./fixtures";

const NOW = "2026-10-25T08:00:00.000Z";
const ID = "0195f0a0-0000-7000-8000-0000000000b1";
const ID2 = "0195f0a0-0000-7000-8000-0000000000b2";

function expectValid(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  expect(result.error?.issues ?? []).toEqual([]);
}

function expectInvalid(schema: z.ZodType, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("API 版本 2 與協定一致的列舉", () => {
  it("API 版本是 2", () => {
    expect(API_VERSION).toBe(2);
  });

  it("推理強度、Repo 種類、送出方式與模型的推理強度能力由協定產生", () => {
    expectTypeOf<Effort>().toEqualTypeOf<protocol.Effort>();
    expectTypeOf<RepoKind>().toEqualTypeOf<protocol.RepoKind>();
    expectTypeOf<PromptDelivery>().toEqualTypeOf<protocol.PromptDelivery>();
    expectTypeOf<EffortSupport>().toEqualTypeOf<protocol.EffortSupport>();
  });

  it("錯誤代碼不重複", () => {
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
    expectValid(ApiError, {
      error: "repo_not_connected",
      message: "GitHub App 沒有安裝在這個 repo 上",
      installUrl: "https://github.com/apps/orbis/installations/new",
    });
  });

  it("新路由都有，參數可以代入", () => {
    for (const route of [
      API_ROUTES.runPrompts,
      API_ROUTES.runPrompt,
      API_ROUTES.runSettings,
      API_ROUTES.runSwitchAgent,
      API_ROUTES.projectBoardSummary,
      API_ROUTES.agentCatalog,
      API_ROUTES.repoConnectGithub,
      API_ROUTES.taskShare,
      API_ROUTES.taskShareMembers,
      API_ROUTES.taskShareMember,
      API_ROUTES.taskShareGeneral,
      API_ROUTES.taskShareInvites,
      API_ROUTES.taskShareInvite,
      API_ROUTES.runPreviewInvites,
      API_ROUTES.runPreviewInvite,
      API_ROUTES.runTerminals,
      API_ROUTES.terminalWs,
    ]) {
      expect(route.startsWith("/api/")).toBe(true);
    }
  });
});

describe("run-prompt：執行中傳訊息", () => {
  it("預設排隊；可以中斷；空白訊息不行", () => {
    expect(CreateRunPromptInput.parse({ text: " 順便改文案 " })).toEqual({
      text: "順便改文案",
      delivery: "queue",
    });
    expectValid(CreateRunPromptInput, { text: "停一下", delivery: "interrupt" });
    expectInvalid(CreateRunPromptInput, { text: "  " });
    expectInvalid(CreateRunPromptInput, { text: "x", delivery: "later" });
    expectValid(RunPromptCreated, { controlId: ID });
  });
});

describe("event-actor：Event 的作者", () => {
  it("RunEvent 帶 actorMemberId", () => {
    expectValid(RunEvent, { ...fixtures.runEvent, actorMemberId: ID });
    expectInvalid(RunEvent, { ...fixtures.runEvent, actorMemberId: undefined });
  });
});

describe("task-pull-request 與 Task 分享欄位", () => {
  it("Task 帶 PR、一般存取與目前登入者的權限", () => {
    expectValid(Task, {
      ...fixtures.task,
      status: "pr_open",
      pullRequest: {
        number: 42,
        url: "https://github.com/acme/web-app/pull/42",
        state: "merged",
        runId: fixtures.run.id,
        openedAt: NOW,
        mergedAt: NOW,
      },
      generalAccess: "invited",
      viewerAccess: "edit",
    });
    expectInvalid(Task, { ...fixtures.task, generalAccess: "team-edit" });
    expectInvalid(Task, { ...fixtures.task, viewerAccess: "owner" });
  });

  it("不指定 Repo 的 Task", () => {
    expectValid(Task, { ...fixtures.task, repoId: null });
  });
});

describe("stopped-run-reason", () => {
  it("每種原因都可以；attempt 只在 verification_limit 有值", () => {
    for (const reasonCode of STOPPED_RUN_REASONS) {
      const attempt = reasonCode === "verification_limit" ? 4 : null;
      expectValid(NeedsYouItem, {
        ...fixtures.needsYouStoppedRun,
        reasonCode,
        attempt,
        detail: reasonCode === "local_merge_blocked" ? "error: Your local changes..." : null,
      });
    }
  });

  it("通知帶同樣的原因；其他種類為 null", () => {
    const base = {
      id: ID,
      kind: "run_stopped",
      taskId: ID2,
      taskKey: "ORB-12",
      runId: ID,
      gateId: null,
      actorMemberId: null,
      title: "ORB-12 停下來了",
      body: null,
      url: "/tasks/ORB-12",
      readAt: null,
      createdAt: NOW,
    };
    expectValid(Notification, {
      ...base,
      stoppedRun: { reasonCode: "push_failed", attempt: null, detail: "rejected" },
    });
    expectInvalid(Notification, {
      ...base,
      stoppedRun: { reasonCode: "push_failed", attempt: 2, detail: null },
    });
  });
});

describe("board-summary", () => {
  it("包一層 tasks；最新 Run 可以是 null", () => {
    expectValid(BoardSummaryResponse, {
      tasks: [
        {
          taskId: ID,
          latestRun: { id: ID2, status: "awaiting_gate", gate: "review", agent: "codex" },
          acceptance: { passed: 2, failed: 1, total: 4 },
        },
        { taskId: ID2, latestRun: null, acceptance: { passed: 0, failed: 0, total: 0 } },
      ],
    });
    expectInvalid(BoardSummaryResponse, []);
  });
});

describe("member-email", () => {
  it("登入資訊帶 email", () => {
    expectValid(MeResponse, {
      githubUserId: 1,
      githubLogin: "octocat",
      name: null,
      avatarUrl: null,
      member: { id: ID, teamId: ID2, teamName: "Acme", role: "member", email: "o@example.com" },
    });
    expectInvalid(MeResponse, {
      githubUserId: 1,
      githubLogin: "octocat",
      name: null,
      avatarUrl: null,
      member: { id: ID, teamId: ID2, teamName: "Acme", role: "member" },
    });
  });
});

describe("model-catalog", () => {
  const entry = {
    agentId: "claude-code",
    tool: "Claude Code",
    vendor: "Anthropic",
    cliId: "claude",
    models: [
      {
        id: "claude-sonnet-5-5",
        name: "Sonnet 5.5",
        tag: "balanced",
        effort: { kind: "adjustable" },
        source: "session",
      },
      {
        id: "claude-haiku-5-5",
        name: "Haiku 5.5",
        tag: "fast",
        effort: { kind: "fixed", level: "fast" },
        source: "profile",
      },
    ],
    signedIn: null,
    loginHint: { kind: "cli", command: "claude login" },
  };

  it("目錄的 model 帶推理強度能力與來源", () => {
    expectValid(AgentCatalogResponse, [entry]);
    expectInvalid(AgentCatalogResponse, [
      {
        ...entry,
        models: [
          {
            id: "x",
            name: "X",
            tag: null,
            effort: { kind: "fixed" },
            source: "profile",
          },
        ],
      },
    ]);
  });
});

describe("run-settings、dispatch-effort、agent-switch", () => {
  const snapshot = {
    agent: "claude-code",
    model: "claude-sonnet-5-5",
    effort: "std",
    permissionPolicy: "auto",
  };

  it("設定與切換紀錄", () => {
    expectValid(RunSettings, {
      initial: snapshot,
      current: { ...snapshot, agent: "codex", model: "gpt-5-codex", effort: null },
      changes: [
        {
          seq: 12,
          ts: NOW,
          actorMemberId: ID,
          agent: "codex",
          model: "gpt-5-codex",
          effort: null,
          permissionPolicy: null,
          notApplied: [],
        },
        {
          seq: 20,
          ts: NOW,
          actorMemberId: null,
          agent: null,
          model: null,
          effort: "deep",
          permissionPolicy: null,
          notApplied: ["effort"],
        },
      ],
    });
  });

  it("PATCH 至少一個欄位、不能換 Agent，回 202 與 control id", () => {
    expectValid(UpdateRunSettingsInput, { effort: "deep" });
    expectValid(UpdateRunSettingsInput, { permissionPolicy: "manual" });
    expectInvalid(UpdateRunSettingsInput, {});
    expectInvalid(UpdateRunSettingsInput, { agent: "codex" });
    expectValid(RunSettingsUpdated, { controlIds: [ID, ID2] });
    expectInvalid(RunSettingsUpdated, { controlIds: [] });
  });

  it("派工可以指定推理強度", () => {
    expect(
      CreateRunInput.parse({ agent: "claude-code", runnerKind: "local", effort: "fast" }).effort,
    ).toBe("fast");
    expectInvalid(CreateRunInput, { agent: "claude-code", runnerKind: "local", effort: "max" });
  });

  it("換 Agent", () => {
    expect(SwitchAgentInput.parse({ agent: "codex" })).toEqual({
      agent: "codex",
      model: null,
      effort: null,
    });
    expectValid(AgentSwitchRequested, { controlId: ID });
  });
});

describe("local-repo 與 repo-connect-github", () => {
  it("Repo 以 kind 區分；本機 Repo 沒有 owner 與 github", () => {
    expectValid(Repo, fixtures.repo);
    expectValid(Repo, { ...fixtures.repo, kind: "local", owner: null, github: null });
    expectInvalid(Repo, { ...fixtures.repo, kind: "local" });
    expectInvalid(Repo, { ...fixtures.repo, owner: null, github: null });
  });

  it("登記本機 Repo 不套用 GitHub 的命名規則，但名稱要能放進路徑", () => {
    expectValid(CreateRepoInput, { kind: "local", name: "我的筆記" });
    expectValid(CreateRepoInput, { kind: "local", name: "notes app", defaultBranch: "trunk" });
    for (const name of ["", ".hidden", "-x", "a/b", "a\\b", "c:", "x.", "x ", "CON", "nul.txt"]) {
      expect(LocalRepoName.safeParse(name).success, name).toBe(false);
    }
    expectInvalid(CreateRepoInput, { kind: "local", owner: "acme", name: "notes" });
    expectInvalid(CreateRepoInput, { owner: "acme", name: "web" });
  });

  it("Project 的本機合併設定", () => {
    expectValid(Project, fixtures.project);
    expectInvalid(Project, {
      ...fixtures.project,
      policy: { ...fixtures.project.policy, localMergeStrategy: "rebase" },
    });
  });

  it("連接到 GitHub 用 GitHub 的命名規則", () => {
    expectValid(ConnectRepoToGithubInput, { owner: "acme", name: "notes" });
    expectInvalid(ConnectRepoToGithubInput, { owner: "acme", name: "我的筆記" });
  });

  it("Repo Spec 提交：PR 與本機 commit 恰好一個", () => {
    expectValid(RepoSpecCommitResponse, {
      pullRequest: null,
      localCommit: { commitSha: "a".repeat(40), changed: true },
      created: false,
      overwritesUpstreamChanges: false,
    });
    expectInvalid(RepoSpecCommitResponse, {
      pullRequest: null,
      localCommit: null,
      created: false,
      overwritesUpstreamChanges: false,
    });
  });
});

describe("task-sharing 與 task-invites", () => {
  it("分享的內容", () => {
    expectValid(TaskShare, {
      ownerMemberId: ID,
      members: [
        { memberId: ID, role: "owner" },
        { memberId: ID2, role: "view" },
      ],
      invites: [
        {
          id: ID,
          email: "new@example.com",
          role: "edit",
          expiresAt: NOW,
          invitedByMemberId: ID,
          createdAt: NOW,
        },
      ],
      generalAccess: "team_view",
    });
  });

  it("加入成員與邀請不能給 owner；轉移擁有者用 PATCH", () => {
    expectValid(AddTaskShareMembersInput, { memberIds: [ID], role: "edit" });
    expectInvalid(AddTaskShareMembersInput, { memberIds: [ID], role: "owner" });
    expectInvalid(AddTaskShareMembersInput, { memberIds: [], role: "view" });
    expectValid(UpdateTaskShareMemberInput, { role: "owner" });
    expectValid(UpdateGeneralAccessInput, { generalAccess: "invited" });
    expectInvalid(UpdateGeneralAccessInput, { generalAccess: "team-edit" });
    expect(CreateTaskInviteInput.parse({ email: " New@Example.com ", role: "view" })).toEqual({
      email: "new@example.com",
      role: "view",
    });
    expectInvalid(CreateTaskInviteInput, { email: "not-an-email", role: "view" });
    expectInvalid(CreateTaskInviteInput, { email: "a@example.com", role: "owner" });
  });

  it("邀請的結果：已是 Member 直接加入，或產生邀請連結", () => {
    expectValid(TaskInviteCreated, {
      kind: "invited",
      invite: {
        id: ID,
        email: "new@example.com",
        role: "edit",
        expiresAt: NOW,
        invitedByMemberId: ID,
        createdAt: NOW,
      },
      inviteUrl: "https://orbis.example.com/invites/abc",
      emailSent: false,
    });
  });
});

describe("preview-share", () => {
  it("Team 的兩個設定；修改至少一個欄位", () => {
    expectValid(Team, {
      id: ID,
      name: "Acme",
      allowExternalPreview: false,
      allowTeamRunnerTerminal: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expectValid(UpdateTeamInput, { allowExternalPreview: true });
    expectInvalid(UpdateTeamInput, {});
  });

  it("以 GitHub 帳號或 email 邀請，預設 24 小時", () => {
    expect(CreatePreviewInviteInput.parse({ githubLogin: "octocat" })).toEqual({
      githubLogin: "octocat",
      duration: "24h",
    });
    expectValid(CreatePreviewInviteInput, { email: "pm@example.com", duration: "7d" });
    expectInvalid(CreatePreviewInviteInput, { email: "pm@example.com", duration: "30d" });
    expectInvalid(CreatePreviewInviteInput, {});
  });

  it("邀請恰好指定一位：GitHub 帳號或 email", () => {
    const invite = {
      id: ID,
      runId: ID2,
      githubLogin: "octocat",
      githubUserId: 583231,
      email: null,
      expiresAt: NOW,
      createdByMemberId: ID,
      createdAt: NOW,
      revokedAt: null,
      lastOpenedAt: null,
      status: "active",
    };
    expectValid(PreviewInvite, invite);
    expectInvalid(PreviewInvite, { ...invite, email: "x@example.com" });
    expectValid(PreviewInviteCreated, {
      invite,
      inviteUrl: "https://orbis.example.com/preview-invites/abc",
      emailSent: true,
    });
  });
});

describe("terminal", () => {
  it("開啟的大小與回應", () => {
    expectValid(CreateTerminalInput, { cols: 120, rows: 32 });
    expectInvalid(CreateTerminalInput, { cols: 0, rows: 32 });
    expectValid(TerminalCreated, { terminalId: ID, wsUrl: `/api/terminals/${ID}/ws` });
    expectInvalid(TerminalCreated, { terminalId: ID, wsUrl: "wss://evil.example.com/" });
  });

  it("WebSocket 的訊息；資料是 base64", () => {
    expectValid(TerminalClientMessage, { type: "input", data: "bHMNCg==" });
    expectInvalid(TerminalClientMessage, { type: "input", data: "不是 base64" });
    expectValid(TerminalClientMessage, { type: "resize", cols: 80, rows: 24 });
    expectValid(TerminalServerMessage, { type: "output", data: "UkVBRE1FDQo=" });
    expectValid(TerminalServerMessage, { type: "exited", code: null, reason: "idle_timeout" });
    expectValid(TerminalServerMessage, {
      type: "error",
      code: "forbidden",
      message: "沒有權限",
    });
  });
});
