import type * as protocol from "@orbis/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AddMemberInput,
  API_ROUTES,
  ApiError,
  apiPath,
  CreateProjectInput,
  CreateRepoInput,
  CreateRunInput,
  canTransitionManually,
  DispatchOptions,
  Gate,
  GateDecisionInput,
  MANUAL_TASK_TRANSITIONS,
  Member,
  type NeedsYouPermissionRequest,
  PairingTokenCreated,
  PermissionResponseInput,
  ReviewDiff,
  type ReviewDiffFile,
  type RouteParams,
  Runner,
  SetProjectRoleInput,
  TASK_STATUSES,
  type Task,
  type TaskDoneReason,
  UpdateProjectInput,
  WebClientMessage,
  WebServerMessage,
} from "../src/index";

const NOW = "2026-10-23T08:00:00.000Z";
const ID = "0195f0a0-0000-7000-8000-0000000000a1";

describe("API_ROUTES 與 apiPath", () => {
  it("代入參數並編碼", () => {
    expect(apiPath(API_ROUTES.taskByKey, { taskKey: "ORB-12" })).toBe("/api/tasks/by-key/ORB-12");
    expect(apiPath(API_ROUTES.runPermissionResponse, { runId: "r 1", requestId: "q/2" })).toBe(
      "/api/runs/r%201/permission-requests/q%2F2/response",
    );
    expect(apiPath(API_ROUTES.needsYou)).toBe("/api/needs-you");
  });

  it("參數名稱由路徑推導", () => {
    expectTypeOf<RouteParams<typeof API_ROUTES.projectRole>>().toEqualTypeOf<
      "projectId" | "memberId"
    >();
    expectTypeOf<RouteParams<typeof API_ROUTES.ws>>().toEqualTypeOf<never>();
  });

  it("所有路徑都在 /api 之下，而且不重複", () => {
    const paths = Object.values(API_ROUTES);
    for (const path of paths) expect(path.startsWith("/api/")).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("手動轉換表", () => {
  it("只有 Backlog ↔ Ready", () => {
    expect(canTransitionManually("backlog", "ready")).toBe(true);
    expect(canTransitionManually("ready", "backlog")).toBe(true);
    expect(canTransitionManually("ready", "running")).toBe(false);
    expect(canTransitionManually("done", "backlog")).toBe(false);
    expect(Object.keys(MANUAL_TASK_TRANSITIONS).sort()).toEqual([...TASK_STATUSES].sort());
  });
});

describe("Team、Member、Runner", () => {
  it("Member 以數字 user id 識別", () => {
    const member = {
      id: ID,
      teamId: ID,
      githubUserId: 13392701,
      githubLogin: "Kashionz",
      name: null,
      avatarUrl: null,
      role: "owner",
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(Member.safeParse(member).success).toBe(true);
    expect(Member.safeParse({ ...member, githubUserId: 0 }).success).toBe(false);
    expect(AddMemberInput.parse({ githubLogin: " octocat " })).toEqual({
      githubLogin: "octocat",
      role: "member",
    });
  });

  it("Runner 帶在線狀態、是否接受 Dispatch 與 Agent 清單", () => {
    const runner = {
      id: ID,
      teamId: ID,
      kind: "local",
      memberId: ID,
      name: "laptop",
      runnerVersion: "0.1.0",
      os: "windows",
      arch: "x86_64",
      online: true,
      acceptingDispatches: false,
      lastHeartbeatAt: NOW,
      agents: [
        {
          agent: "claude-code",
          credential: "default",
          available: true,
          maxConcurrency: 30,
          details: null,
        },
      ],
      createdAt: NOW,
    };
    expect(Runner.safeParse(runner).success).toBe(true);
    expect(
      PairingTokenCreated.safeParse({ id: ID, kind: "local", token: "pt", expiresAt: NOW }).success,
    ).toBe(true);
  });
});

describe("Project 與 Repo 的輸入", () => {
  it("建立 Project 時政策可以部分指定", () => {
    expect(CreateProjectInput.parse({ name: "Core", keyPrefix: "ORB" })).toEqual({
      name: "Core",
      keyPrefix: "ORB",
      description: "",
      policy: {},
    });
    expect(
      CreateProjectInput.safeParse({
        name: "Core",
        keyPrefix: "ORB",
        policy: { autoCreateIssues: false, defaultPermissionPolicy: "manual" },
      }).success,
    ).toBe(true);
    expect(UpdateProjectInput.safeParse({}).success).toBe(false);
  });

  it("Role 覆寫不能是 Owner", () => {
    expect(SetProjectRoleInput.safeParse({ role: "admin" }).success).toBe(true);
    expect(SetProjectRoleInput.safeParse({ role: "owner" }).success).toBe(false);
  });

  it.each([
    ["不合法的 owner", { owner: "-bad", name: "web" }],
    ["repo 名稱是 ..", { owner: "Kashionz", name: ".." }],
    ["分支以 - 開頭", { owner: "Kashionz", name: "web", defaultBranch: "-x" }],
    ["分支含 ..", { owner: "Kashionz", name: "web", defaultBranch: "a..b" }],
  ])("拒絕%s", (_, input) => {
    expect(CreateRepoInput.safeParse(input).success).toBe(false);
  });

  it("預設分支是 main", () => {
    expect(CreateRepoInput.parse({ owner: "Kashionz", name: "orbis" }).defaultBranch).toBe("main");
  });
});

describe("派工", () => {
  it("yolo 只能在 Local Runner", () => {
    expect(
      CreateRunInput.safeParse({
        agent: "claude-code",
        runnerKind: "local",
        permissionPolicy: "yolo",
      }).success,
    ).toBe(true);
    expect(
      CreateRunInput.safeParse({
        agent: "claude-code",
        runnerKind: "team",
        permissionPolicy: "yolo",
      }).success,
    ).toBe(false);
    expect(CreateRunInput.parse({ agent: "claude-code", runnerKind: "team" })).toEqual({
      agent: "claude-code",
      model: null,
      runnerKind: "team",
    });
  });

  it("派工選項：沒有完成 Pairing 的 Runner 種類為 null", () => {
    expect(
      DispatchOptions.safeParse({
        local: {
          online: true,
          agents: [
            {
              id: "claude-code",
              version: "0.94.0",
              available: true,
              unavailableReason: null,
              models: [],
              permissionGaps: ["Claude 設定中允許的工具不會詢問 Runner"],
            },
          ],
        },
        team: null,
        defaultPermissionPolicy: "auto",
      }).success,
    ).toBe(true);
  });
});

describe("Gate 與 Review", () => {
  it("退回時至少要有一則說明或行內留言", () => {
    expect(GateDecisionInput.safeParse({ action: "approve" }).success).toBe(true);
    expect(GateDecisionInput.safeParse({ action: "abort" }).success).toBe(true);
    expect(GateDecisionInput.safeParse({ action: "reject" }).success).toBe(false);
    expect(
      GateDecisionInput.safeParse({
        action: "reject",
        reviewComments: [{ path: "src/a.ts", line: 3, side: "new", body: "處理空值" }],
      }).success,
    ).toBe(true);
    expect(
      GateDecisionInput.safeParse({
        action: "reject",
        reviewComments: [{ path: "src/a.ts", line: 0, side: "new", body: "x" }],
      }).success,
    ).toBe(false);
  });

  it("Gate 帶已保存的行內留言", () => {
    expect(
      Gate.safeParse({
        id: ID,
        taskId: ID,
        runId: ID,
        kind: "review",
        decision: null,
        decidedByMemberId: null,
        decidedAt: null,
        comment: null,
        reviewComments: [
          {
            id: ID,
            gateId: ID,
            path: "a.ts",
            line: 1,
            side: "old",
            body: "x",
            authorMemberId: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        createdAt: NOW,
      }).success,
    ).toBe(true);
  });

  it("Review diff：每個檔案帶完整新舊內容，二進位檔沒有內容", () => {
    const diff = {
      runId: ID,
      seq: 30,
      baseCommit: "a".repeat(40),
      files: [
        {
          path: "a.ts",
          oldPath: null,
          change: "modified",
          binary: false,
          old: { type: "inline", text: "1" },
          new: {
            type: "blob",
            blob_id: ID,
            sha256: "b".repeat(64),
            size: 100,
            media_type: "text/plain",
          },
        },
        { path: "logo.png", oldPath: null, change: "added", binary: true, old: null, new: null },
      ],
    };
    expect(ReviewDiff.safeParse(diff).success).toBe(true);
    expect(
      ReviewDiff.safeParse({ ...diff, files: [{ ...diff.files[1], change: "copied" }] }).success,
    ).toBe(false);
  });

  it("權限回覆只帶選項", () => {
    expect(PermissionResponseInput.safeParse({ optionId: "allow" }).success).toBe(true);
    expect(PermissionResponseInput.safeParse({ optionId: "" }).success).toBe(false);
  });
});

describe("Web 的 WebSocket 訊息", () => {
  it("訂閱與批次推送", () => {
    expect(
      WebClientMessage.safeParse({ type: "subscribe_run", runId: ID, afterSeq: 0 }).success,
    ).toBe(true);
    expect(
      WebClientMessage.safeParse({ type: "subscribe_run", runId: ID, afterSeq: -1 }).success,
    ).toBe(false);
    const event = {
      runId: ID,
      seq: 1,
      ts: NOW,
      event: { kind: "thought_chunk", text: "想一下" },
    };
    expect(
      WebServerMessage.safeParse({ type: "run_events", runId: ID, events: [event] }).success,
    ).toBe(true);
    expect(WebServerMessage.safeParse({ type: "run_events", runId: ID, events: [] }).success).toBe(
      false,
    );
    expect(
      WebServerMessage.safeParse({
        type: "error",
        code: "forbidden",
        message: "沒有權限",
        runId: ID,
      }).success,
    ).toBe(true);
    expect(
      WebServerMessage.safeParse({
        type: "error",
        code: "limit_exceeded",
        message: "訂閱數超過上限",
        runId: null,
      }).success,
    ).toBe(true);
  });

  it("錯誤回應的格式：可以帶驗證問題或 Ready 缺少的項目", () => {
    expect(ApiError.safeParse({ error: "forbidden", message: "沒有權限" }).success).toBe(true);
    expect(
      ApiError.safeParse({
        error: "not_ready",
        message: "Task 還不能進入 Ready",
        missing: ["repo", "acceptance_criteria"],
      }).success,
    ).toBe(true);
    expect(
      ApiError.safeParse({
        error: "invalid_input",
        message: "輸入格式錯誤",
        issues: [{ path: ["policy", "defaultPermissionPolicy"], message: "不合法的值" }],
      }).success,
    ).toBe(true);
    expect(
      ApiError.safeParse({ error: "not_ready", message: "x", missing: ["title"] }).success,
    ).toBe(false);
  });
});

describe("與協定、DB 一致的型別", () => {
  it("Task 的關閉原因、權限請求的用途、diff 的變更種類", () => {
    expectTypeOf<Task["doneReason"]>().toEqualTypeOf<TaskDoneReason | null>();
    expectTypeOf<
      NeedsYouPermissionRequest["purpose"]
    >().toEqualTypeOf<protocol.PermissionPurpose>();
    expectTypeOf<ReviewDiffFile["change"]>().toEqualTypeOf<protocol.FileChange>();
    expectTypeOf<ReviewDiffFile["old"]>().toExtend<protocol.TextBody | null>();
  });
});
