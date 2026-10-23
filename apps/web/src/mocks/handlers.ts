// MSW 的 REST 與 WebSocket handler：路徑取自契約的 API_ROUTES，輸入以契約的 schema 驗證，
// 回應與錯誤的形狀和 Server 相同。

import {
  API_ROUTES,
  CheckAcceptanceCriterionInput,
  CreateAcceptanceCriterionInput,
  CreateProjectInput,
  CreateRepoInput,
  CreateRunInput,
  CreateTaskInput,
  GateDecisionInput,
  PermissionResponseInput,
  TransitionTaskInput,
  UpdateAcceptanceCriterionInput,
  UpdateProjectInput,
  UpdateTaskInput,
  VerificationDecisionInput,
  WEB_WS_MAX_SUBSCRIPTIONS,
  WebClientMessage,
  type WebServerMessage,
} from "@orbis/api-contract";
import { HttpResponse, http, ws } from "msw";
import { ZodError, type z } from "zod";
import { type MockBackend, MockError } from "./backend";

/** 重播時每則 `run_events` 最多帶幾筆 Event（同 Server）。 */
const REPLAY_BATCH_SIZE = 500;

type Resolver = (request: Request, params: Record<string, string>) => unknown | Promise<unknown>;

/** 把 MockError 與 zod 錯誤轉成契約 ApiError 形狀的錯誤回應。 */
function handle(resolver: Resolver, status = 200) {
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

async function parse<S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> {
  return schema.parse(await request.json());
}

export function createHandlers(backend: MockBackend) {
  const session = backend.config.session ?? "ok";

  const socketUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}${API_ROUTES.ws}`;
  const events = ws.link(socketUrl);

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
    client.addEventListener("close", unlisten);
  });

  return [
    eventsHandler,

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
      API_ROUTES.members,
      handle(() => backend.members()),
    ),
    http.get(
      API_ROUTES.needsYou,
      handle(() => backend.needsYou()),
    ),
  ];
}
