// MSW 的 REST 與 WebSocket handler：路徑取自契約的 API_ROUTES，輸入以契約的 schema 驗證，
// 回應與錯誤的形狀和 Server 相同。

import {
  AddMemberInput,
  AnswerChildQuestionInput,
  API_ROUTES,
  API_VERSION,
  CheckAcceptanceCriterionInput,
  CreateAcceptanceCriterionInput,
  CreatePairingTokenInput,
  CreateProjectInput,
  CreateRepoInput,
  CreateRepoSpecInput,
  CreateRunInput,
  CreateTaskCommentInput,
  CreateTaskInput,
  DraftTaskBatchInput,
  GateDecisionInput,
  MarkNotificationsReadInput,
  NotificationPreferences,
  PermissionResponseInput,
  RepoSpecCommitInput,
  SetProjectRoleInput,
  TransitionTaskInput,
  UpdateAcceptanceCriterionInput,
  UpdateDraftTaskInput,
  UpdateMemberInput,
  UpdateProjectInput,
  UpdateRunnerCredentialInput,
  UpdateTaskCommentInput,
  UpdateTaskInput,
  UpdateTeamInput,
  VerificationDecisionInput,
  WEB_WS_MAX_SUBSCRIPTIONS,
  WebClientMessage,
  type WebServerMessage,
} from "@orbis/api-contract";
import { PROTOCOL_VERSION } from "@orbis/protocol";
import { HttpResponse, http, ws } from "msw";
import { ZodError, type z } from "zod";
import { type MockBackend, MockError } from "./backend";
import { MockCollabServer } from "./collab";
import { createPrototypeHandlers } from "./prototype-features";
import { createWorkspaceHandlers } from "./workspace";

/** 重播時每則 `run_events` 最多帶幾筆 Event（同 Server）。 */
const REPLAY_BATCH_SIZE = 500;

type Resolver = (request: Request, params: Record<string, string>) => unknown | Promise<unknown>;

/** 把 MockError 與 zod 錯誤轉成契約 ApiError 形狀的錯誤回應。 */
export function handle(resolver: Resolver, status = 200) {
  return async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
    try {
      const body = await resolver(request, params as Record<string, string>);
      return body === undefined
        ? new HttpResponse(null, { status: 204 })
        : HttpResponse.json(body, { status });
    } catch (error) {
      if (error instanceof MockError) {
        return HttpResponse.json(
          { error: error.code, message: error.message, ...error.details },
          { status: error.status },
        );
      }
      if (error instanceof ZodError) {
        return HttpResponse.json(
          {
            error: "invalid_input",
            message: "輸入格式不正確",
            issues: error.issues.map((issue) => ({
              path: issue.path.map((key) => (typeof key === "symbol" ? String(key) : key)),
              message: issue.message,
            })),
          },
          { status: 400 },
        );
      }
      throw error;
    }
  };
}

export async function parse<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S>> {
  return schema.parse(await request.json());
}

export function createHandlers(backend: MockBackend) {
  const session = backend.config.session ?? "ok";

  const socketUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}${API_ROUTES.ws}`;
  const events = ws.link(socketUrl);

  const collab = new MockCollabServer(backend);
  const collabLink = ws.link(`${socketUrl.slice(0, -API_ROUTES.ws.length)}/api/collab/*`);
  const collabHandler = collabLink.addEventListener("connection", ({ client }) => {
    const docName = decodeURIComponent(client.url.pathname.slice("/api/collab/".length));
    const result = collab.connect(docName, (data) => client.send(new Uint8Array(data)));
    if (typeof result === "number") {
      client.close(result, "rejected");
      return;
    }
    client.addEventListener("message", async (message) => {
      const data = message.data;
      const bytes =
        data instanceof Blob
          ? new Uint8Array(await data.arrayBuffer())
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : null;
      if (bytes) result.onMessage(bytes);
    });
    client.addEventListener("close", result.onClose);
  });

  const eventsHandler = events.addEventListener("connection", ({ client }) => {
    const subscribed = new Set<string>();
    const send = (message: WebServerMessage) => client.send(JSON.stringify(message));
    const unlisten = backend.onEvents((runId, appended) => {
      if (subscribed.has(runId)) send({ type: "run_events", runId, events: appended });
    });
    client.addEventListener("message", (message) => {
      const parsed = WebClientMessage.safeParse(JSON.parse(String(message.data)));
      if (!parsed.success) {
        send({ type: "error", code: "invalid_message", message: "無法解析的訊息", runId: null });
        return;
      }
      if (parsed.data.type === "unsubscribe_run") {
        subscribed.delete(parsed.data.runId);
        return;
      }
      const { runId, afterSeq } = parsed.data;
      if (!subscribed.has(runId) && subscribed.size >= WEB_WS_MAX_SUBSCRIPTIONS) {
        send({
          type: "error",
          code: "limit_exceeded",
          message: `每條連線最多訂閱 ${WEB_WS_MAX_SUBSCRIPTIONS} 個 Run`,
          runId,
        });
        return;
      }
      try {
        const replay = backend.events(runId, afterSeq);
        subscribed.add(runId);
        for (let start = 0; start < replay.length; start += REPLAY_BATCH_SIZE) {
          send({
            type: "run_events",
            runId,
            events: replay.slice(start, start + REPLAY_BATCH_SIZE),
          });
        }
      } catch (error) {
        send({
          type: "error",
          code: "not_found",
          message: error instanceof Error ? error.message : String(error),
          runId,
        });
      }
    });
    const unlistenNotifications = backend.onNotification((notification) =>
      send({ type: "notification", notification }),
    );
    client.addEventListener("close", () => {
      unlisten();
      unlistenNotifications();
    });
  });

  return [
    eventsHandler,
    collabHandler,
    ...createWorkspaceHandlers(backend),

    // 版本相容（ARCHITECTURE §16）：依設定回不同的版本
    http.get(API_ROUTES.health, () => {
      const health = backend.config.health ?? "ok";
      const api =
        health === "web-outdated"
          ? API_VERSION + 1
          : health === "server-outdated"
            ? API_VERSION - 1
            : API_VERSION;
      return HttpResponse.json({
        ok: true,
        apiOrigin: window.location.origin,
        ...(health !== "no-versions" && {
          versions: { server: "0.0.0-mock", api, protocol: PROTOCOL_VERSION },
        }),
      });
    }),
    http.get(API_ROUTES.authMe, () => {
      if (session === "unauthorized" || backend.snapshot.loggedOut) {
        return HttpResponse.json({ error: "unauthorized", message: "尚未登入" }, { status: 401 });
      }
      if (session === "error") {
        return HttpResponse.json({ error: "internal", message: "內部錯誤" }, { status: 500 });
      }
      return HttpResponse.json(backend.me());
    }),
    http.post(
      API_ROUTES.authLogout,
      handle(() => {
        backend.logout();
      }),
    ),

    http.get(
      API_ROUTES.projects,
      handle(() => backend.projects()),
    ),
    http.post(
      API_ROUTES.projects,
      handle(
        async (request) => backend.createProject(await parse(request, CreateProjectInput)),
        201,
      ),
    ),
    http.get(
      API_ROUTES.project,
      handle((_, p) => backend.getProject(p.projectId ?? "")),
    ),
    http.patch(
      API_ROUTES.project,
      handle(async (request, p) =>
        backend.updateProject(p.projectId ?? "", await parse(request, UpdateProjectInput)),
      ),
    ),
    http.get(
      API_ROUTES.projectRepos,
      handle((_, p) => backend.repos(p.projectId ?? "")),
    ),
    http.post(
      API_ROUTES.projectRepos,
      handle(
        async (request, p) =>
          backend.createRepo(p.projectId ?? "", await parse(request, CreateRepoInput)),
        201,
      ),
    ),
    http.post(
      API_ROUTES.repoRefreshInstallation,
      handle((_, p) => backend.refreshRepoInstallation(p.repoId ?? "")),
    ),
    http.delete(
      API_ROUTES.repo,
      handle((_, p) => {
        backend.deleteRepo(p.repoId ?? "");
      }),
    ),
    http.get(
      API_ROUTES.repoSpecs,
      handle((_, p) => backend.repoSpecs(p.repoId ?? "")),
    ),
    http.post(
      API_ROUTES.repoSpecs,
      handle(
        async (request, p) =>
          backend.createRepoSpec(p.repoId ?? "", await parse(request, CreateRepoSpecInput)),
        201,
      ),
    ),
    http.get(
      API_ROUTES.repoSpec,
      handle((_, p) => backend.repoSpec(p.repoSpecId ?? "")),
    ),
    http.post(
      API_ROUTES.repoSpecCommit,
      handle(async (request, p) =>
        backend.commitRepoSpec(p.repoSpecId ?? "", await parse(request, RepoSpecCommitInput)),
      ),
    ),
    http.get(
      API_ROUTES.projectTasks,
      handle((_, p) => backend.tasks(p.projectId ?? "")),
    ),
    http.post(
      API_ROUTES.projectTasks,
      handle(
        async (request, p) =>
          backend.createTaskAsMember(p.projectId ?? "", await parse(request, CreateTaskInput)),
        201,
      ),
    ),
    http.get(
      API_ROUTES.projectDraftTasks,
      handle((_, p) => backend.draftTasks(p.projectId ?? "")),
    ),
    http.post(
      API_ROUTES.projectDraftTasksConfirm,
      handle(async (request, p) =>
        backend.confirmDraftTasks(
          p.projectId ?? "",
          (await parse(request, DraftTaskBatchInput)).draftTaskIds,
        ),
      ),
    ),
    http.post(
      API_ROUTES.projectDraftTasksDismiss,
      handle(async (request, p) => {
        backend.dismissDraftTasks(
          p.projectId ?? "",
          (await parse(request, DraftTaskBatchInput)).draftTaskIds,
        );
      }),
    ),
    http.patch(
      API_ROUTES.draftTask,
      handle(async (request, p) =>
        backend.updateDraftTask(p.draftTaskId ?? "", await parse(request, UpdateDraftTaskInput)),
      ),
    ),
    http.post(
      API_ROUTES.draftTaskConfirm,
      handle((_, p) => backend.confirmDraftTask(p.draftTaskId ?? ""), 201),
    ),
    http.post(
      API_ROUTES.draftTaskDismiss,
      handle((_, p) => {
        backend.dismissDraftTask(p.draftTaskId ?? "");
      }),
    ),
    http.get(
      API_ROUTES.projectDispatchOptions,
      handle((_, p) => backend.dispatchOptions(p.projectId ?? "")),
    ),

    http.get(
      API_ROUTES.taskByKey,
      handle((_, p) => backend.taskByKey(p.taskKey ?? "")),
    ),
    http.get(
      API_ROUTES.task,
      handle((_, p) => backend.task(p.taskId ?? "")),
    ),
    http.patch(
      API_ROUTES.task,
      handle(async (request, p) =>
        backend.updateTask(p.taskId ?? "", await parse(request, UpdateTaskInput)),
      ),
    ),
    http.post(
      API_ROUTES.taskTransition,
      handle(async (request, p) =>
        backend.transitionTask(p.taskId ?? "", (await parse(request, TransitionTaskInput)).status),
      ),
    ),
    http.get(
      API_ROUTES.taskAcceptanceCriteria,
      handle((_, p) => backend.acceptanceCriteria(p.taskId ?? "")),
    ),
    http.post(
      API_ROUTES.taskAcceptanceCriteria,
      handle(
        async (request, p) =>
          backend.createAcceptanceCriterionAsMember(
            p.taskId ?? "",
            await parse(request, CreateAcceptanceCriterionInput),
          ),
        201,
      ),
    ),
    http.patch(
      API_ROUTES.acceptanceCriterion,
      handle(async (request, p) =>
        backend.updateAcceptanceCriterion(
          p.criterionId ?? "",
          await parse(request, UpdateAcceptanceCriterionInput),
        ),
      ),
    ),
    http.delete(
      API_ROUTES.acceptanceCriterion,
      handle((_, p) => {
        backend.deleteAcceptanceCriterion(p.criterionId ?? "");
      }),
    ),
    http.get(
      API_ROUTES.taskGates,
      handle((_, p) => backend.taskGates(p.taskId ?? "")),
    ),

    http.get(
      API_ROUTES.taskRuns,
      handle((_, p) => backend.taskRuns(p.taskId ?? "")),
    ),
    http.post(
      API_ROUTES.taskRuns,
      handle(
        async (request, p) =>
          backend.dispatchAsMember(p.taskId ?? "", await parse(request, CreateRunInput)),
        201,
      ),
    ),
    http.get(
      API_ROUTES.run,
      handle((_, p) => backend.run(p.runId ?? "")),
    ),
    http.get(
      API_ROUTES.runEvents,
      handle((request, p) => {
        const url = new URL(request.url);
        const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 500);
        return backend.events(p.runId ?? "", afterSeq, limit);
      }),
    ),
    http.post(
      API_ROUTES.runPermissionResponse,
      handle(async (request, p) => {
        const input = await parse(request, PermissionResponseInput);
        backend.respondToPermissionAsMember(p.runId ?? "", p.requestId ?? "", input.optionId);
      }),
    ),
    http.get(
      API_ROUTES.runReviewDiff,
      handle((_, p) => backend.reviewDiff(p.runId ?? "")),
    ),
    http.post(
      API_ROUTES.runCancel,
      handle((_, p) => backend.cancelRun(p.runId ?? ""), 202),
    ),
    http.get(
      API_ROUTES.runPreview,
      handle((_, p) => backend.previewState(p.runId ?? "")),
    ),
    http.post(
      API_ROUTES.runPreviewRestart,
      handle((_, p) => {
        backend.previewState(p.runId ?? "");
      }),
    ),
    http.post(
      API_ROUTES.runPreviewScreenshots,
      handle(async (request, p) => {
        const file = (await request.formData()).get("file");
        if (!(file instanceof Blob)) throw new MockError(400, "invalid_input", "缺少截圖");
        return backend.uploadPreviewScreenshot(p.runId ?? "", file);
      }, 201),
    ),
    http.get(
      API_ROUTES.runVerifications,
      handle((_, p) => backend.verifications(p.runId ?? "")),
    ),
    http.post(
      API_ROUTES.runVerificationDecision,
      handle(async (request, p) => {
        backend.decideVerification(p.runId ?? "", await parse(request, VerificationDecisionInput));
      }),
    ),
    http.post(
      API_ROUTES.acceptanceCriterionCheck,
      handle(async (request, p) =>
        backend.checkAcceptanceCriterion(
          p.criterionId ?? "",
          (await parse(request, CheckAcceptanceCriterionInput)).checked,
        ),
      ),
    ),
    http.post(
      API_ROUTES.childQuestionAnswer,
      handle(async (request, p) => {
        const { answer } = await parse(request, AnswerChildQuestionInput);
        backend.answerChildQuestion(p.questionId ?? "", answer);
      }),
    ),
    http.post(
      API_ROUTES.gateDecision,
      handle(async (request, p) =>
        backend.decideGate(p.gateId ?? "", await parse(request, GateDecisionInput)),
      ),
    ),

    http.get(API_ROUTES.blob, ({ params }) => {
      try {
        const content = backend.blob(String(params.blobId ?? ""));
        // 圖片（Verification 的截圖）以 data URL 保存
        if (content.startsWith("data:")) {
          const [meta = "", data = ""] = content.slice("data:".length).split(",");
          const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
          return new HttpResponse(bytes, { headers: { "content-type": meta.split(";")[0] ?? "" } });
        }
        return new HttpResponse(content, {
          headers: { "content-type": "text/plain" },
        });
      } catch (error) {
        if (!(error instanceof MockError)) throw error;
        return HttpResponse.json(
          { error: error.code, message: error.message },
          { status: error.status },
        );
      }
    }),

    http.get(
      API_ROUTES.notifications,
      handle((request) => {
        const url = new URL(request.url);
        return backend.notifications(
          url.searchParams.get("unreadOnly") === "true",
          url.searchParams.get("before"),
          Number(url.searchParams.get("limit") ?? 50),
        );
      }),
    ),
    http.get(
      API_ROUTES.notificationsUnreadCount,
      handle(() => backend.unreadNotificationCount()),
    ),
    http.post(
      API_ROUTES.notificationsRead,
      handle(async (request) => {
        backend.markNotificationsRead(await parse(request, MarkNotificationsReadInput));
      }),
    ),
    http.get(
      API_ROUTES.notificationPreferences,
      handle(() => backend.notificationPreferences()),
    ),
    http.put(
      API_ROUTES.notificationPreferences,
      handle(async (request) =>
        backend.updateNotificationPreferences(await parse(request, NotificationPreferences)),
      ),
    ),
    http.get(
      API_ROUTES.projectMentionCandidates,
      handle((_, p) => backend.mentionCandidates(p.projectId ?? "")),
    ),
    http.get(
      API_ROUTES.taskMentions,
      handle((_, p) => backend.taskMentions(p.taskId ?? "")),
    ),
    http.get(
      API_ROUTES.taskComments,
      handle((_, p) => backend.taskComments(p.taskId ?? "")),
    ),
    http.post(
      API_ROUTES.taskComments,
      handle(
        async (request, p) =>
          backend.createTaskComment(
            p.taskId ?? "",
            (await parse(request, CreateTaskCommentInput)).body,
          ),
        201,
      ),
    ),
    http.patch(
      API_ROUTES.taskComment,
      handle(async (request, p) =>
        backend.updateTaskComment(
          p.commentId ?? "",
          (await parse(request, UpdateTaskCommentInput)).body,
        ),
      ),
    ),
    http.delete(
      API_ROUTES.taskComment,
      handle((_, p) => {
        backend.deleteTaskComment(p.commentId ?? "");
      }),
    ),
    http.get(
      API_ROUTES.credentials,
      handle(() => backend.credentials()),
    ),
    http.patch(
      API_ROUTES.runnerCredential,
      handle(async (request, p) => {
        const input = await parse(request, UpdateRunnerCredentialInput);
        backend.updateRunnerCredential(
          p.runnerId ?? "",
          p.credential ?? "",
          input.maxConcurrentRuns,
        );
      }),
    ),
    http.get(
      API_ROUTES.teamRunnerQueue,
      handle(() => backend.teamRunnerQueue()),
    ),
    http.get(
      API_ROUTES.runners,
      handle(() => backend.runners()),
    ),
    http.post(
      API_ROUTES.pairingTokens,
      handle(
        async (request) =>
          backend.createPairingToken((await parse(request, CreatePairingTokenInput)).kind),
        201,
      ),
    ),
    http.post(
      API_ROUTES.members,
      handle(async (request) => backend.addMember(await parse(request, AddMemberInput)), 201),
    ),
    http.patch(
      API_ROUTES.member,
      handle(async (request, p) =>
        backend.updateMember(p.memberId ?? "", (await parse(request, UpdateMemberInput)).role),
      ),
    ),
    http.delete(
      API_ROUTES.member,
      handle((_, p) => {
        backend.removeMember(p.memberId ?? "");
      }),
    ),
    http.get(
      API_ROUTES.projectRoles,
      handle((_, p) => backend.projectRoles(p.projectId ?? "")),
    ),
    http.put(
      API_ROUTES.projectRole,
      handle(async (request, p) =>
        backend.setProjectRole(
          p.projectId ?? "",
          p.memberId ?? "",
          (await parse(request, SetProjectRoleInput)).role,
        ),
      ),
    ),
    http.delete(
      API_ROUTES.projectRole,
      handle((_, p) => {
        backend.deleteProjectRole(p.projectId ?? "", p.memberId ?? "");
      }),
    ),
    http.get(
      API_ROUTES.members,
      handle(() => backend.members()),
    ),
    http.get(
      API_ROUTES.team,
      handle(() => backend.team()),
    ),
    http.patch(
      API_ROUTES.team,
      handle(async (request) => backend.updateTeam((await parse(request, UpdateTeamInput)).name)),
    ),
    http.get(
      API_ROUTES.needsYou,
      handle(() => backend.needsYou()),
    ),
    // 原型中有、後端還沒有的功能（lib/features.ts）
    ...createPrototypeHandlers(backend),
  ];
}
