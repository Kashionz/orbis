// MSW 的 REST 與 WebSocket handler，依 src/api/paths.ts 的暫時端點模擬 Server。
// TODO(api): 端點對齊 contract/web-api 後跟著修改。

import {
  CreateAcceptanceCriterionInput,
  CreateTaskInput,
  TransitionTaskInput,
  UpdateAcceptanceCriterionInput,
  UpdateTaskInput,
} from "@orbis/api-contract";
import { HttpResponse, http, ws } from "msw";
import type { z } from "zod";
import { API_PATHS } from "../api/paths";
import {
  ClientFrame,
  CreateRunInput,
  PermissionResponseInput,
  ReviewDecisionInput,
  type ServerFrame,
} from "../api/schemas";
import { type MockBackend, MockError } from "./backend";

/** 重播時每個 frame 最多帶幾筆 Event。 */
const REPLAY_BATCH_SIZE = 500;

type Resolver = (request: Request, params: Record<string, string>) => unknown | Promise<unknown>;

/** 把 MockError 與 zod 錯誤轉成 Server 風格的錯誤回應。 */
function handle(resolver: Resolver) {
  return async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
    try {
      const body = await resolver(request, params as Record<string, string>);
      return body === undefined ? new HttpResponse(null, { status: 204 }) : HttpResponse.json(body);
    } catch (error) {
      if (error instanceof MockError) {
        return HttpResponse.json(
          { error: error.code, message: error.message },
          { status: error.status },
        );
      }
      if (error instanceof Error && error.name === "ZodError") {
        return HttpResponse.json(
          { error: "invalid_input", message: error.message },
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

  const socketUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}${API_PATHS.eventsSocket}`;
  const events = ws.link(socketUrl);

  const eventsHandler = events.addEventListener("connection", ({ client }) => {
    const subscribed = new Set<string>();
    const send = (frame: ServerFrame) => client.send(JSON.stringify(frame));
    const unlisten = backend.onEvents((runId, appended) => {
      if (subscribed.has(runId)) send({ type: "events", runId, events: appended });
    });
    client.addEventListener("message", (message) => {
      const frame = ClientFrame.safeParse(JSON.parse(String(message.data)));
      if (!frame.success) {
        send({ type: "error", runId: null, message: "無法解析的 frame" });
        return;
      }
      if (frame.data.type === "unsubscribe") {
        subscribed.delete(frame.data.runId);
        return;
      }
      const { runId, fromSeq } = frame.data;
      try {
        const replay = backend.events(runId, fromSeq - 1);
        subscribed.add(runId);
        for (let start = 0; start < replay.length; start += REPLAY_BATCH_SIZE) {
          send({ type: "events", runId, events: replay.slice(start, start + REPLAY_BATCH_SIZE) });
        }
      } catch (error) {
        send({
          type: "error",
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    client.addEventListener("close", unlisten);
  });

  return [
    eventsHandler,

    http.get("/api/auth/me", () => {
      if (session === "unauthorized") {
        return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      if (session === "error") return HttpResponse.json({ error: "internal" }, { status: 500 });
      return HttpResponse.json(backend.me());
    }),

    http.get(
      API_PATHS.projects,
      handle(() => backend.projects()),
    ),
    http.get(
      "/api/projects/:projectId/repos",
      handle((_, p) => backend.repos(p.projectId ?? "")),
    ),
    http.get(
      "/api/projects/:projectId/tasks",
      handle((_, p) => backend.tasks(p.projectId ?? "")),
    ),
    http.post(
      "/api/projects/:projectId/tasks",
      handle(async (request, p) =>
        backend.createTaskAsMember(p.projectId ?? "", await parse(request, CreateTaskInput)),
      ),
    ),

    http.get(
      "/api/tasks/by-key/:taskKey",
      handle((_, p) => backend.taskByKey(p.taskKey ?? "")),
    ),
    http.get(
      "/api/tasks/:taskId",
      handle((_, p) => backend.task(p.taskId ?? "")),
    ),
    http.patch(
      "/api/tasks/:taskId",
      handle(async (request, p) =>
        backend.updateTask(p.taskId ?? "", await parse(request, UpdateTaskInput)),
      ),
    ),
    http.post(
      "/api/tasks/:taskId/transition",
      handle(async (request, p) =>
        backend.transitionTask(p.taskId ?? "", (await parse(request, TransitionTaskInput)).status),
      ),
    ),
    http.get(
      "/api/tasks/:taskId/acceptance-criteria",
      handle((_, p) => backend.acceptanceCriteria(p.taskId ?? "")),
    ),
    http.post(
      "/api/tasks/:taskId/acceptance-criteria",
      handle(async (request, p) =>
        backend.createAcceptanceCriterionAsMember(
          p.taskId ?? "",
          await parse(request, CreateAcceptanceCriterionInput),
        ),
      ),
    ),
    http.patch(
      "/api/acceptance-criteria/:id",
      handle(async (request, p) =>
        backend.updateAcceptanceCriterion(
          p.id ?? "",
          await parse(request, UpdateAcceptanceCriterionInput),
        ),
      ),
    ),
    http.delete(
      "/api/acceptance-criteria/:id",
      handle((_, p) => {
        backend.deleteAcceptanceCriterion(p.id ?? "");
      }),
    ),

    http.get(
      "/api/tasks/:taskId/runs",
      handle((_, p) => backend.taskRuns(p.taskId ?? "")),
    ),
    http.post(
      "/api/tasks/:taskId/runs",
      handle(async (request, p) =>
        backend.dispatchAsMember(p.taskId ?? "", await parse(request, CreateRunInput)),
      ),
    ),
    http.get(
      "/api/runs/:runId",
      handle((_, p) => backend.run(p.runId ?? "")),
    ),
    http.get(
      "/api/runs/:runId/events",
      handle((request, p) => {
        const url = new URL(request.url);
        const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 1000);
        return backend.events(p.runId ?? "", afterSeq, limit);
      }),
    ),
    http.post(
      "/api/runs/:runId/permission-responses",
      handle(async (request, p) => {
        const input = await parse(request, PermissionResponseInput);
        backend.respondToPermissionAsMember(
          p.runId ?? "",
          input.permissionRequestId,
          input.optionId,
        );
      }),
    ),
    http.get(
      "/api/runs/:runId/review-diff",
      handle((_, p) => backend.reviewDiff(p.runId ?? "")),
    ),
    http.post(
      "/api/runs/:runId/review",
      handle(async (request, p) => {
        backend.decideReview(p.runId ?? "", await parse(request, ReviewDecisionInput));
      }),
    ),
    http.post(
      "/api/runs/:runId/cancel",
      handle((_, p) => {
        backend.cancelRun(p.runId ?? "");
      }),
    ),

    http.get(
      API_PATHS.members,
      handle(() => backend.members()),
    ),
    http.get(
      API_PATHS.dispatchOptions,
      handle(() => backend.dispatchOptions()),
    ),
    http.get(
      API_PATHS.needsYou,
      handle(() => backend.needsYou()),
    ),
  ];
}
