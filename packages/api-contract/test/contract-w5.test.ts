import type * as protocol from "@orbis/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  AcceptanceCriterion,
  AnswerChildQuestionInput,
  API_ROUTES,
  apiPath,
  CheckAcceptanceCriterionInput,
  COLLAB_CLOSE_CODES,
  CreateRepoSpecInput,
  CreateTaskCommentInput,
  CredentialStatus,
  DraftTask,
  DraftTaskBatchInput,
  formatCollabDocName,
  formatMention,
  Gate,
  GateDecisionInput,
  MarkNotificationsReadInput,
  Mention,
  type MentionTarget,
  NEEDS_YOU_KINDS,
  NeedsYouItem,
  NOTIFICATION_KINDS,
  Notification,
  NotificationDesktopFeed,
  NotificationPreferences,
  PreviewComment,
  PreviewCommentInput,
  PreviewState,
  Project,
  parseCollabDocName,
  parseMentions,
  RepoSpec,
  ReviewCommentInput,
  type RouteParams,
  Run,
  type RunOrigin,
  replaceMentions,
  TaskComment,
  TaskNote,
  TeamRunnerQueueItem,
  UpdateDraftTaskInput,
  UpdateRunnerCredentialInput,
  Verification,
  VerificationDecisionInput,
  type VerificationOutcome,
  WebServerMessage,
} from "../src/index";
import * as fixtures from "./fixtures";

const NOW = "2026-10-23T08:00:00.000Z";
const ID = "0195f0a0-0000-7000-8000-0000000000a1";
const ID2 = "0195f0a0-0000-7000-8000-0000000000a2";

function expectValid(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  expect(result.error?.issues ?? []).toEqual([]);
}

function expectInvalid(schema: z.ZodType, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("與協定一致的列舉", () => {
  it("Run 的來源與 Verification 結果由協定產生", () => {
    expectTypeOf<RunOrigin>().toEqualTypeOf<protocol.RunOrigin>();
    expectTypeOf<VerificationOutcome>().toEqualTypeOf<protocol.VerificationOutcome>();
    expectTypeOf<Run["origin"]>().toEqualTypeOf<protocol.RunOrigin>();
  });

  it("Needs You 加入 child_question，通知種類包含 Feedback Loop 的上限", () => {
    expect(NEEDS_YOU_KINDS).toContain("child_question");
    expect(NOTIFICATION_KINDS).toContain("feedback_limit_reached");
  });
});

describe("既有資源的新增欄位", () => {
  it("Run 帶來源、Credential 與接續的 Run", () => {
    expectValid(Run, fixtures.run);
    expectValid(Run, {
      ...fixtures.run,
      origin: "feedback_loop",
      resumesRunId: ID,
    });
    expectInvalid(Run, { ...fixtures.run, origin: "manual" });
    const { origin: _, ...withoutOrigin } = fixtures.run;
    expectInvalid(Run, withoutOrigin);
  });

  it("Project 的政策帶 Verification 重試上限與 bot 白名單", () => {
    expectValid(Project, fixtures.project);
    for (const verificationMaxRetries of [0, 11, 2.5]) {
      expectInvalid(Project, {
        ...fixtures.project,
        policy: { ...fixtures.project.policy, verificationMaxRetries },
      });
    }
    expectInvalid(Project, {
      ...fixtures.project,
      policy: { ...fixtures.project.policy, feedbackBotAllowlist: [""] },
    });
  });

  it("Acceptance Criterion 帶判定摘要與判定者", () => {
    expectValid(AcceptanceCriterion, {
      ...fixtures.acceptanceCriterion,
      result: "failed",
      resultSummary: "2 個測試失敗",
      checkedByRunId: ID,
    });
    expectValid(CheckAcceptanceCriterionInput, { checked: true });
    expectInvalid(CheckAcceptanceCriterionInput, { checked: "yes" });
  });

  it("Needs You 的 child_question 帶問題與 Child Run", () => {
    expectValid(NeedsYouItem, fixtures.needsYouChildQuestion);
    expectInvalid(NeedsYouItem, { ...fixtures.needsYouChildQuestion, question: "" });
    expectValid(AnswerChildQuestionInput, { answer: "存在 HttpOnly cookie" });
    expectInvalid(AnswerChildQuestionInput, { answer: "  " });
  });
});

describe("Review Gate 的 Preview 留言", () => {
  it("行內留言維持 M1 的格式", () => {
    expectValid(ReviewCommentInput, { path: "a.ts", line: 3, side: "new", body: "處理空值" });
    expectInvalid(ReviewCommentInput, {
      kind: "diff",
      path: "a.ts",
      line: 3,
      side: "new",
      body: "x",
    });
  });

  it("Preview 留言帶網址、selector 與截圖", () => {
    expect(
      PreviewCommentInput.parse({
        body: "按鈕太小",
        url: "https://r1.preview.example.com/login",
        selector: "#submit",
        screenshotBlobId: ID,
      }),
    ).toMatchObject({ selector: "#submit", screenshotBlobId: ID });
    expect(PreviewCommentInput.parse({ body: "整頁", url: "https://x.example.com/" })).toEqual({
      body: "整頁",
      url: "https://x.example.com/",
      selector: null,
      screenshotBlobId: null,
    });
    expectInvalid(PreviewCommentInput, { body: "x", url: "not a url" });
    // 會顯示成連結，只接受 http(s)
    expectInvalid(PreviewCommentInput, { body: "x", url: "javascript:alert(1)" });
    expectInvalid(PreviewCommentInput, { body: "x", url: "file:///etc/passwd" });
    expectInvalid(PreviewCommentInput, { body: "x", url: "https://x/", line: 1 });
  });

  it("退回可以只帶 Preview 留言；什麼都沒有時拒絕", () => {
    const parsed = GateDecisionInput.parse({
      action: "reject",
      previewComments: [{ body: "顏色不對", url: "https://x.example.com/" }],
    });
    expect(parsed).toMatchObject({ reviewComments: [], comment: null });
    expect(GateDecisionInput.parse({ action: "reject", comment: "重寫" })).toMatchObject({
      previewComments: [],
    });
    expectInvalid(GateDecisionInput, { action: "reject", previewComments: [] });
  });

  it("Gate 分別帶行內留言與 Preview 留言", () => {
    const gate = {
      id: ID,
      taskId: ID2,
      runId: ID,
      kind: "review",
      decision: "rejected",
      decidedByMemberId: ID,
      decidedAt: NOW,
      comment: null,
      reviewComments: [],
      previewComments: [
        {
          id: ID2,
          gateId: ID,
          body: "x",
          url: "https://x.example.com/",
          selector: null,
          screenshotBlobId: ID,
          authorMemberId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      planSeq: null,
      reviewDiffSeq: 30,
      createdAt: NOW,
    };
    expectValid(Gate, gate);
    const { previewComments: _, ...withoutPreview } = gate;
    expectInvalid(Gate, withoutPreview);
    expectInvalid(PreviewComment, { ...gate.previewComments[0], url: null });
  });
});

describe("Verification", () => {
  const verification = {
    id: ID,
    runId: ID2,
    taskId: ID2,
    attempt: 2,
    status: "failed",
    resolution: null,
    resolvedByMemberId: null,
    comment: null,
    awaitingDecision: true,
    results: [
      {
        criterionId: ID,
        outcome: "failed",
        summary: "pnpm test 失敗",
        evidence: [
          {
            type: "command_output",
            command: "pnpm test",
            exit_code: 1,
            output: { type: "inline", text: "FAIL" },
            truncated: false,
          },
        ],
        judgedByRunId: null,
        createdAt: NOW,
      },
    ],
    startedAt: NOW,
    completedAt: NOW,
  };

  it("每一輪帶結果與協定形狀的證據", () => {
    expectValid(Verification, verification);
    expectInvalid(Verification, { ...verification, attempt: 0 });
    expectInvalid(Verification, { ...verification, status: "pending" });
    expectInvalid(Verification, {
      ...verification,
      results: [{ ...verification.results[0], evidence: ["log"] }],
    });
  });

  it("awaitingDecision 是必填的布林值", () => {
    const { awaitingDecision: _, ...withoutFlag } = verification;
    expectInvalid(Verification, withoutFlag);
    expectInvalid(Verification, { ...verification, awaitingDecision: "yes" });
  });

  it("超過上限後的決定：再試（可附意見）、略過、中止", () => {
    expect(VerificationDecisionInput.parse({ action: "retry" })).toEqual({
      action: "retry",
      comment: null,
    });
    expectValid(VerificationDecisionInput, { action: "retry", comment: "先修 lint" });
    expectValid(VerificationDecisionInput, { action: "skip" });
    expectValid(VerificationDecisionInput, { action: "abort" });
    expectInvalid(VerificationDecisionInput, { action: "skip", comment: "x" });
    expectInvalid(VerificationDecisionInput, { action: "approve" });
  });
});

describe("Draft Task", () => {
  const draft = {
    id: ID,
    projectId: ID2,
    batchId: ID2,
    position: 2,
    proposedByRunId: ID,
    repoId: null,
    spec: "docs/specs/auth.md",
    title: "登出時撤銷 refresh token",
    description: "",
    acceptanceCriteria: [
      { kind: "command", description: "測試通過", command: "pnpm test" },
      { kind: "manual", description: "安全性 review", command: null },
    ],
    dependsOn: ["#1", "ORB-7"],
    createdAt: NOW,
    updatedAt: NOW,
  };

  it("接受合法的 Draft Task", () => {
    expectValid(DraftTask, draft);
  });

  it("相依只能是 #n 或 Task Key；只有 command 類型可以帶指令", () => {
    expectInvalid(DraftTask, { ...draft, dependsOn: ["#0"] });
    expectInvalid(DraftTask, { ...draft, dependsOn: ["orb-7"] });
    expectInvalid(DraftTask, {
      ...draft,
      acceptanceCriteria: [{ kind: "manual", description: "x", command: "ls" }],
    });
  });

  it("修改至少一個欄位；批次 1–100 個", () => {
    expectValid(UpdateDraftTaskInput, { title: "新標題" });
    expectInvalid(UpdateDraftTaskInput, {});
    expectInvalid(UpdateDraftTaskInput, { status: "ready" });
    expectValid(DraftTaskBatchInput, { draftTaskIds: [ID] });
    expectInvalid(DraftTaskBatchInput, { draftTaskIds: [] });
    expectInvalid(DraftTaskBatchInput, { draftTaskIds: Array(101).fill(ID) });
  });
});

describe("Task note 與 Task 留言", () => {
  it("Task note 帶來源與連結", () => {
    expectValid(TaskNote, {
      id: ID,
      taskId: ID2,
      runId: ID,
      source: "feedback_loop",
      body: "第 1 次自動修正（CI）",
      url: "https://github.com/acme/web/pull/3#issuecomment-1",
      createdAt: NOW,
    });
    expectInvalid(TaskNote, {
      id: ID,
      taskId: ID2,
      runId: null,
      source: "member",
      body: "x",
      url: null,
      createdAt: NOW,
    });
  });

  it("留言的作者是 Member 或 Run 其中之一", () => {
    const comment = {
      id: ID,
      taskId: ID2,
      authorMemberId: ID,
      authorRunId: null,
      body: "@[claude](agent:claude-code) 幫我看這段",
      consultRunIds: [ID2],
      createdAt: NOW,
      updatedAt: NOW,
    };
    expectValid(TaskComment, comment);
    expectValid(TaskComment, { ...comment, authorMemberId: null, authorRunId: ID2 });
    expectInvalid(TaskComment, { ...comment, authorRunId: ID2 });
    expectInvalid(CreateTaskCommentInput, { body: "   " });
  });
});

describe("@mention 的寫法", () => {
  const member: MentionTarget = { type: "member", memberId: ID };
  const agent: MentionTarget = { type: "agent", agent: "claude-code" };

  it("format 後再 parse 得到相同的對象與位置", () => {
    const text = `請 ${formatMention("octocat", member)} 與 ${formatMention("claude", agent)} 看一下`;
    const mentions = parseMentions(text);
    expect(mentions.map((m) => [m.label, m.target])).toEqual([
      ["octocat", member],
      ["claude", agent],
    ]);
    for (const m of mentions) expect(text.slice(m.start, m.end).startsWith("@[")).toBe(true);
  });

  it("顯示名稱中的 ] 與換行不會破壞格式", () => {
    const token = formatMention("a]b\nc", member);
    expect(parseMentions(token)).toHaveLength(1);
    expect(formatMention("", agent)).toBe("@[claude-code](agent:claude-code)");
  });

  it("格式不對的 token 當成一般文字", () => {
    expect(parseMentions("@octocat")).toEqual([]);
    expect(parseMentions("@[x](user:1)")).toEqual([]);
    expect(parseMentions("@[x](agent:Claude Code)")).toEqual([]);
    expect(parseMentions("@[x](member:)")).toEqual([]);
  });

  it("略過 fenced code block 與行內程式碼中的 token", () => {
    const token = formatMention("octocat", member);
    const text = [
      `請 ${token} 看`,
      "```ts",
      `const x = "${token}";`,
      "```",
      `行內 \`${token}\` 不算`,
      `雙反引號 \`\` ${token} \`\` 也不算`,
      "~~~",
      token,
      "~~~",
      `最後 ${formatMention("claude", agent)}`,
    ].join("\n");
    expect(parseMentions(text).map((m) => m.label)).toEqual(["octocat", "claude"]);
    expect(parseMentions(text)[0]?.start).toBe(2);
  });

  it("沒有結束的 fence 到文末都算程式碼", () => {
    const text = `${formatMention("a", member)}\n\`\`\`\n${formatMention("b", member)}`;
    expect(parseMentions(text).map((m) => m.label)).toEqual(["a"]);
  });

  it("replaceMentions 保留程式碼中的 token 原樣", () => {
    const token = formatMention("octocat", member);
    const text = `${token} 與 \`${token}\`\n\`\`\`\n${token}\n\`\`\``;
    expect(replaceMentions(text, () => "@octocat")).toBe(
      `@octocat 與 \`${token}\`\n\`\`\`\n${token}\n\`\`\``,
    );
  });

  it("Mention 資源帶對象與 @agent 建立的 Run", () => {
    expectValid(Mention, {
      id: ID,
      sourceKind: "collab_document",
      sourceId: `repo-spec-draft:${ID2}`,
      nodeId: "0195f0a0-0000-7000-8000-0000000000ff",
      target: agent,
      consultRunId: ID2,
      createdAt: NOW,
    });
    expectInvalid(Mention, {
      id: ID,
      sourceKind: "task",
      sourceId: ID2,
      nodeId: "x",
      target: member,
      consultRunId: null,
      createdAt: NOW,
    });
  });

  it("同步到 GitHub 時換成 @login", () => {
    const text = `${formatMention("octocat", member)}：${formatMention("claude", agent)} 說好了`;
    expect(replaceMentions(text, (m) => (m.target.type === "member" ? "@octocat" : m.label))).toBe(
      "@octocat：claude 說好了",
    );
  });
});

describe("通知", () => {
  const notification = {
    id: ID,
    kind: "gate_pending",
    taskId: ID2,
    taskKey: "ORB-12",
    runId: ID,
    gateId: ID,
    actorMemberId: null,
    title: "ORB-12 的 Review Gate 等待核准",
    body: null,
    url: "/tasks/ORB-12",
    readAt: null,
    createdAt: NOW,
  };

  it("接受合法的通知；拒絕不存在的種類", () => {
    expectValid(Notification, notification);
    expectInvalid(Notification, { ...notification, kind: "build_failed" });
    for (const url of [
      "https://evil.example.com/",
      "//evil.example.com",
      "/\\evil",
      "tasks/ORB-12",
      "javascript:alert(1)",
    ]) {
      expectInvalid(Notification, { ...notification, url });
    }
    expectValid(Notification, { ...notification, url: "/runs/r1/review?tab=diff" });
    expectValid(NotificationDesktopFeed, { items: [notification], cursor: "c1" });
  });

  it("標為已讀：指定 id 或全部", () => {
    expectValid(MarkNotificationsReadInput, { ids: [ID] });
    expectValid(MarkNotificationsReadInput, { all: true });
    expectInvalid(MarkNotificationsReadInput, { all: false });
    expectInvalid(MarkNotificationsReadInput, { ids: [] });
  });

  it("個人設定：關閉的種類與勿擾時段（可以跨午夜）", () => {
    expectValid(NotificationPreferences, {
      disabledKinds: ["task_assigned"],
      quietHours: { start: "22:00", end: "08:00", timeZone: "Asia/Taipei" },
    });
    expectValid(NotificationPreferences, { disabledKinds: [], quietHours: null });
    for (const quietHours of [
      { start: "24:00", end: "08:00", timeZone: "Asia/Taipei" },
      { start: "8:00", end: "09:00", timeZone: "Asia/Taipei" },
      { start: "08:00", end: "08:00", timeZone: "Asia/Taipei" },
      { start: "22:00", end: "08:00", timeZone: "Mars/Olympus" },
    ]) {
      expectInvalid(NotificationPreferences, { disabledKinds: [], quietHours });
    }
  });

  it("WebSocket 推送通知", () => {
    expectValid(WebServerMessage, { type: "notification", notification });
  });
});

describe("Credential 與佇列", () => {
  it("Credential 的有效上限、用量與 rate limit", () => {
    expectValid(CredentialStatus, {
      runnerId: ID,
      runnerName: "team-1",
      runnerKind: "team",
      online: true,
      credential: "claude-subscription",
      agents: ["claude-code"],
      reportedMaxConcurrentRuns: 30,
      maxConcurrentRunsOverride: 10,
      maxConcurrentRuns: 10,
      activeRuns: 10,
      queuedRuns: 3,
      rateLimitedUntil: NOW,
      usage24h: { runs: 42, inputTokens: 1_000_000, outputTokens: null, cost: null },
    });
    expectValid(UpdateRunnerCredentialInput, { maxConcurrentRuns: null });
    expectInvalid(UpdateRunnerCredentialInput, { maxConcurrentRuns: 0 });
  });

  it("佇列帶順位與等待原因", () => {
    expectValid(TeamRunnerQueueItem, {
      runId: ID,
      taskId: ID2,
      taskKey: "ORB-12",
      agent: "claude-code",
      credential: "claude-subscription",
      position: 1,
      waitingReason: "rate_limited",
      queuedAt: NOW,
    });
  });
});

describe("Repo Spec", () => {
  it("路徑必須是 repo 內的相對 .md 路徑", () => {
    expectValid(CreateRepoSpecInput, { path: "docs/specs/auth.md" });
    expectValid(CreateRepoSpecInput, { path: "docs/.github/a.md" });
    for (const path of [
      "/docs/a.md",
      "docs/../a.md",
      "docs\\a.md",
      "docs/a.txt",
      "a//b.md",
      "docs/\n../a.md",
      "docs/a\u0000.md",
      "./a.md",
      ".github/workflows/a.md",
      ".GitHub/a.md",
    ]) {
      expectInvalid(CreateRepoSpecInput, { path });
    }
  });

  it("帶版本與開著的 PR", () => {
    expectValid(RepoSpec, {
      id: ID,
      repoId: ID2,
      path: "docs/specs/auth.md",
      title: null,
      version: 0,
      committedSha: null,
      openPullRequest: { number: 3, url: "https://github.com/acme/web/pull/3" },
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
});

describe("共同編輯的文件名稱", () => {
  it("format 後再 parse 得到相同的結果", () => {
    const name = formatCollabDocName({ kind: "task-description", id: ID });
    expect(name).toBe(`task-description:${ID}`);
    expect(parseCollabDocName(name)).toEqual({ kind: "task-description", id: ID });
  });

  it("close code 與 /api/ws 的 4401 一致", () => {
    expect(COLLAB_CLOSE_CODES).toEqual({ unauthorized: 4401, forbidden: 4403, notFound: 4404 });
  });

  it("拒絕不認得的種類與不合法的 ID", () => {
    expect(parseCollabDocName(`task:${ID}`)).toBeNull();
    expect(parseCollabDocName("repo-spec-draft:")).toBeNull();
    expect(parseCollabDocName("repo-spec-draft:a/b")).toBeNull();
    expect(() => formatCollabDocName({ kind: "repo-spec-draft", id: "a:b" })).toThrow();
  });
});

describe("Preview", () => {
  it("狀態帶本機與分享網址、停止的原因", () => {
    expectValid(PreviewState, {
      status: "stopped",
      port: 4123,
      localUrl: "http://localhost:4123/",
      shareUrl: null,
      runnerId: ID,
      stopped: { reason: "ready_timeout", exitCode: null, output: "" },
    });
    expectInvalid(PreviewState, {
      status: "crashed",
      port: null,
      localUrl: null,
      shareUrl: null,
      runnerId: null,
      stopped: null,
    });
  });
});

describe("W5–7 的路由", () => {
  it("參數名稱由路徑推導", () => {
    expectTypeOf<RouteParams<typeof API_ROUTES.runnerCredential>>().toEqualTypeOf<
      "runnerId" | "credential"
    >();
    expectTypeOf<RouteParams<typeof API_ROUTES.collab>>().toEqualTypeOf<"docName">();
  });

  it("Credential 名稱與文件名稱會被編碼", () => {
    expect(apiPath(API_ROUTES.runnerCredential, { runnerId: "r1", credential: "a/b" })).toBe(
      "/api/runners/r1/credentials/a%2Fb",
    );
    expect(apiPath(API_ROUTES.collab, { docName: `task-description:${ID}` })).toBe(
      `/api/collab/task-description%3A${ID}`,
    );
  });
});
