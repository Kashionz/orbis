// Task 留言、Task 上的 @mention 與 @mention 的自動完成候選（ARCHITECTURE §12.3）。
//
// - 能查看 Task 的人都能留言（Viewer 也可以）；只能修改或刪除自己的留言。
// - 新增或修改留言時處理新出現的 @mention（mentions/service.ts）：@member 通知，@agent 建立 consult Run。
// - Agent 的回覆（consult Run 結束後貼回）作者是那個 Run，不能經由 API 修改。

import {
  API_ROUTES,
  CreateTaskCommentInput,
  type MentionCandidates,
  type MentionListResponse,
  type TaskComment,
  UpdateTaskCommentInput,
} from "@orbis/api-contract";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { loadProjectScope, loadTaskScope, requireProjectCapability } from "../authz/scope";
import { agentAvailabilities, members, mentions, runners, taskComments } from "../db/schema";
import { type Executor, inTransaction } from "../db/tx";
import { forbidden, notFound, readId, readJson } from "../http/errors";
import type { AppEnv } from "../http/session";
import type { Services } from "../services";

type CommentRow = typeof taskComments.$inferSelect;

/** 留言與這則留言中的 @agent 建立的 Run。 */
async function toTaskComments(db: Executor, rows: CommentRow[]): Promise<TaskComment[]> {
  const ids = rows.map((r) => r.id);
  const runsByComment =
    ids.length > 0
      ? await db
          .select({ sourceId: mentions.sourceId, runId: mentions.consultRunId })
          .from(mentions)
          .where(
            and(
              eq(mentions.sourceKind, "task_comment"),
              inArray(mentions.sourceId, ids),
              isNotNull(mentions.consultRunId),
            ),
          )
          .orderBy(asc(mentions.createdAt))
      : [];
  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    authorMemberId: row.authorMemberId,
    authorRunId: row.authorRunId,
    body: row.body,
    consultRunIds: runsByComment
      .filter((m) => m.sourceId === row.id && m.runId)
      .map((m) => m.runId as string),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/** Agent Profile id 的顯示名稱：`claude-code` → `claude`。 */
export const agentLabel = (agent: string) => agent.split("-")[0] || agent;

export function createCommentRoutes(s: Services): Hono<AppEnv> {
  const { db, auth } = s;
  const app = new Hono<AppEnv>();

  app.get(API_ROUTES.taskComments, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireProjectCapability(actor, scope, "view");
    const rows = await db
      .select()
      .from(taskComments)
      .where(eq(taskComments.taskId, scope.task.id))
      .orderBy(asc(taskComments.createdAt), asc(taskComments.id));
    return c.json(await toTaskComments(db, rows));
  });

  app.post(API_ROUTES.taskComments, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireProjectCapability(actor, scope, "view");
    const input = await readJson(c, CreateTaskCommentInput);
    const comment = await inTransaction(db, async (uow) => {
      const [row] = await uow.tx
        .insert(taskComments)
        .values({ taskId: scope.task.id, authorMemberId: actor.memberId, body: input.body })
        .returning();
      if (!row) throw new Error("建立留言失敗");
      await s.mentions.processText(
        uow,
        { kind: "task_comment", id: row.id },
        {
          projectId: scope.project.id,
          task: scope.task,
          actorMemberId: actor.memberId,
          text: row.body,
        },
      );
      return row;
    });
    const [view] = await toTaskComments(db, [comment]);
    return c.json(view, 201);
  });

  app.patch(API_ROUTES.taskComment, auth, async (c) => {
    const actor = c.get("actor");
    const existing = await loadComment(db, readId(c, "commentId", "留言"));
    const scope = await loadTaskScope(db, actor, existing.taskId);
    requireProjectCapability(actor, scope, "view");
    if (existing.authorMemberId !== actor.memberId) throw forbidden("只能修改自己的留言");
    const input = await readJson(c, UpdateTaskCommentInput);
    const comment = await inTransaction(db, async (uow) => {
      const [row] = await uow.tx
        .update(taskComments)
        .set({ body: input.body })
        .where(eq(taskComments.id, existing.id))
        .returning();
      if (!row) throw notFound("留言");
      // 只有新出現的 mention 才會通知或建立 Run。
      await s.mentions.processText(
        uow,
        { kind: "task_comment", id: row.id },
        {
          projectId: scope.project.id,
          task: scope.task,
          actorMemberId: actor.memberId,
          text: row.body,
        },
      );
      return row;
    });
    const [view] = await toTaskComments(db, [comment]);
    return c.json(view);
  });

  app.delete(API_ROUTES.taskComment, auth, async (c) => {
    const actor = c.get("actor");
    const existing = await loadComment(db, readId(c, "commentId", "留言"));
    const scope = await loadTaskScope(db, actor, existing.taskId);
    requireProjectCapability(actor, scope, "view");
    if (existing.authorMemberId !== actor.memberId) throw forbidden("只能刪除自己的留言");
    await db.delete(taskComments).where(eq(taskComments.id, existing.id));
    return c.body(null, 204);
  });

  app.get(API_ROUTES.taskMentions, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireProjectCapability(actor, scope, "view");
    const rows = await db
      .select()
      .from(mentions)
      .where(eq(mentions.taskId, scope.task.id))
      .orderBy(asc(mentions.createdAt), asc(mentions.id));
    const response: MentionListResponse = rows.map((row) => ({
      id: row.id,
      sourceKind: row.sourceKind,
      sourceId: row.sourceId,
      nodeId: row.nodeId,
      target: row.memberId
        ? { type: "member", memberId: row.memberId }
        : { type: "agent", agent: row.agent ?? "" },
      consultRunId: row.consultRunId,
      createdAt: row.createdAt.toISOString(),
    }));
    return c.json(response);
  });

  app.get(API_ROUTES.projectMentionCandidates, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "view");
    const team = await db
      .select()
      .from(members)
      .where(eq(members.teamId, scope.project.teamId))
      .orderBy(asc(members.githubLogin));
    // 目前有 Runner 能跑的 Agent（Local Runner 或 Team Runner）。
    const agents = await db
      .selectDistinct({ agent: agentAvailabilities.agent })
      .from(agentAvailabilities)
      .innerJoin(runners, eq(runners.id, agentAvailabilities.runnerId))
      .where(
        and(
          eq(runners.teamId, scope.project.teamId),
          isNull(runners.revokedAt),
          eq(agentAvailabilities.available, true),
        ),
      )
      .orderBy(asc(agentAvailabilities.agent));
    const response: MentionCandidates = {
      members: team.map((m) => ({
        memberId: m.id,
        githubLogin: m.githubLogin,
        name: m.name,
        avatarUrl: m.avatarUrl,
      })),
      agents: agents.map((a) => ({ agent: a.agent, label: agentLabel(a.agent) })),
    };
    return c.json(response);
  });

  return app;
}

async function loadComment(db: Executor, id: string): Promise<CommentRow> {
  const [row] = await db.select().from(taskComments).where(eq(taskComments.id, id));
  if (!row) throw notFound("留言");
  return row;
}
