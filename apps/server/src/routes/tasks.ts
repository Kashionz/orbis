// Task、Task 相依、Acceptance Criterion、手動狀態轉換（ARCHITECTURE §4、§5）。

import {
  CreateAcceptanceCriterionInput,
  CreateTaskInput,
  formatTaskKey,
  parseTaskKey,
  TaskStatus,
  TransitionTaskInput,
  UpdateAcceptanceCriterionInput,
  UpdateTaskInput,
} from "@orbis/api-contract";
import { and, asc, count, eq, gt, gte, inArray, lt, lte, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  loadProjectScope,
  loadTaskScope,
  requireProjectCapability,
  type TaskRow,
} from "../authz/scope";
import {
  acceptanceCriteria,
  members,
  projects,
  repoSpecs,
  repos,
  runs,
  taskDependencies,
  tasks,
} from "../db/schema";
import { type Executor, inTransaction } from "../db/tx";
import { TERMINAL_RUN_STATUSES } from "../domain/run-status";
import { toAcceptanceCriterion, toTask, toTasks } from "../http/dto";
import {
  ApiError,
  conflict,
  invalidInput,
  notFound,
  readId,
  readJson,
  readQuery,
} from "../http/errors";
import type { Actor, AppEnv } from "../http/session";
import type { Services } from "../services";

const ListTasksQuery = z.object({ status: TaskStatus.optional() });

export function createTaskRoutes(s: Services): Hono<AppEnv> {
  const { db, auth, events } = s;
  const app = new Hono<AppEnv>();

  app.get("/projects/:projectId/tasks", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "view");
    const query = readQuery(c, ListTasksQuery);
    const rows = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, scope.project.id),
          query.status ? eq(tasks.status, query.status) : undefined,
        ),
      )
      .orderBy(asc(tasks.number));
    return c.json(await toTasks(db, rows));
  });

  app.post("/projects/:projectId/tasks", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "edit_task");
    const input = await readJson(c, CreateTaskInput);
    const task = await inTransaction(db, async (uow) => {
      const { tx } = uow;
      // 鎖住 Project：流水號遞增與相依檢查都要序列化。
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, scope.project.id))
        .for("update");
      if (!project) throw notFound("Project");
      await requireRepoInProject(tx, input.repoId, project.id);
      if (input.assigneeMemberId) await requireTeamMember(tx, actor, input.assigneeMemberId);
      await requireTasksInProject(tx, input.dependsOn, project.id);

      const number = project.nextTaskNumber;
      await tx
        .update(projects)
        .set({ nextTaskNumber: number + 1 })
        .where(eq(projects.id, project.id));
      const repoSpecId = input.specPath ? await upsertSpec(tx, input.repoId, input.specPath) : null;
      const [row] = await tx
        .insert(tasks)
        .values({
          projectId: project.id,
          number,
          key: formatTaskKey(project.taskKeyPrefix, number),
          repoId: input.repoId,
          repoSpecId,
          title: input.title,
          description: input.description,
          assigneeMemberId: input.assigneeMemberId,
          createdByMemberId: actor.memberId,
          planGateEnabled: input.planGateEnabled,
        })
        .returning();
      if (!row) throw new Error("建立 Task 失敗");
      const dependsOn = [...new Set(input.dependsOn)];
      if (dependsOn.length > 0) {
        await tx
          .insert(taskDependencies)
          .values(dependsOn.map((d) => ({ taskId: row.id, dependsOnTaskId: d })));
      }
      uow.afterCommit(() =>
        events.emit({ type: "task.created", taskId: row.id, projectId: row.projectId }),
      );
      return row;
    });
    return c.json(await toTask(db, task), 201);
  });

  app.get("/tasks/by-key/:key", auth, async (c) => {
    const actor = c.get("actor");
    const key = c.req.param("key");
    const parsed = parseTaskKey(key);
    if (!parsed) throw notFound("Task");
    const [row] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(
          eq(projects.teamId, actor.teamId),
          eq(projects.taskKeyPrefix, parsed.prefix),
          eq(tasks.number, parsed.number),
        ),
      );
    if (!row) throw notFound("Task");
    const scope = await loadTaskScope(db, actor, row.id);
    requireProjectCapability(actor, scope, "view");
    return c.json(await toTask(db, scope.task));
  });

  app.get("/tasks/:taskId", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireProjectCapability(actor, scope, "view");
    return c.json(await toTask(db, scope.task));
  });

  app.patch("/tasks/:taskId", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireProjectCapability(actor, scope, "edit_task");
    const input = await readJson(c, UpdateTaskInput);
    const task = await inTransaction(db, async (uow) => {
      const { tx } = uow;
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, scope.project.id))
        .for("update");
      const changes: Partial<typeof tasks.$inferInsert> = {};
      if (input.title !== undefined) changes.title = input.title;
      if (input.description !== undefined) changes.description = input.description;
      if (input.planGateEnabled !== undefined) changes.planGateEnabled = input.planGateEnabled;
      if (input.assigneeMemberId !== undefined) {
        if (input.assigneeMemberId) await requireTeamMember(tx, actor, input.assigneeMemberId);
        changes.assigneeMemberId = input.assigneeMemberId;
      }
      if (input.specPath !== undefined) {
        changes.repoSpecId =
          input.specPath && scope.task.repoId
            ? await upsertSpec(tx, scope.task.repoId, input.specPath)
            : null;
      }
      if (input.dependsOn !== undefined) {
        await replaceDependencies(tx, scope.task, [...new Set(input.dependsOn)]);
      }
      const [row] =
        Object.keys(changes).length > 0
          ? await tx.update(tasks).set(changes).where(eq(tasks.id, scope.task.id)).returning()
          : // 只改相依時也更新 updated_at。
            await tx
              .update(tasks)
              .set({ updatedAt: new Date() })
              .where(eq(tasks.id, scope.task.id))
              .returning();
      if (!row) throw notFound("Task");
      uow.afterCommit(() =>
        events.emit({
          type: "task.updated",
          taskId: row.id,
          projectId: row.projectId,
          fields: Object.keys(input),
        }),
      );
      return row;
    });
    return c.json(await toTask(db, task));
  });

  app.delete("/tasks/:taskId", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireProjectCapability(actor, scope, "edit_task");
    await inTransaction(db, async (uow) => {
      const [active] = await uow.tx
        .select({ n: count() })
        .from(runs)
        .where(and(eq(runs.taskId, scope.task.id), notInArray(runs.status, TERMINAL_RUN_STATUSES)));
      if ((active?.n ?? 0) > 0) throw conflict("Task 還有進行中的 Run，請先中止");
      await uow.tx.delete(tasks).where(eq(tasks.id, scope.task.id));
      uow.afterCommit(() =>
        events.emit({ type: "task.deleted", taskId: scope.task.id, projectId: scope.project.id }),
      );
    });
    return c.body(null, 204);
  });

  app.post("/tasks/:taskId/transition", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireProjectCapability(actor, scope, "edit_task");
    const input = await readJson(c, TransitionTaskInput);
    const task = await inTransaction(db, (uow) =>
      s.lifecycle.transition(uow, scope.task.id, input.status, "manual"),
    );
    return c.json(await toTask(db, task));
  });

  // ---- Acceptance Criterion ----

  app.get("/tasks/:taskId/acceptance-criteria", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireProjectCapability(actor, scope, "view");
    const rows = await db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.taskId, scope.task.id))
      .orderBy(asc(acceptanceCriteria.position));
    return c.json(rows.map(toAcceptanceCriterion));
  });

  app.post("/tasks/:taskId/acceptance-criteria", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireProjectCapability(actor, scope, "edit_task");
    const input = await readJson(c, CreateAcceptanceCriterionInput);
    const row = await db.transaction(async (tx) => {
      await lockTask(tx, scope.task.id);
      const size = await criterionCount(tx, scope.task.id);
      const position = Math.min(input.position ?? size, size);
      await tx
        .update(acceptanceCriteria)
        .set({ position: sql`${acceptanceCriteria.position} + 1` })
        .where(
          and(
            eq(acceptanceCriteria.taskId, scope.task.id),
            gte(acceptanceCriteria.position, position),
          ),
        );
      const [created] = await tx
        .insert(acceptanceCriteria)
        .values({
          taskId: scope.task.id,
          kind: input.kind,
          description: input.description,
          command: input.command,
          position,
        })
        .returning();
      return created;
    });
    if (!row) throw new Error("建立 Acceptance Criterion 失敗");
    return c.json(toAcceptanceCriterion(row), 201);
  });

  app.patch("/acceptance-criteria/:criterionId", auth, async (c) => {
    const actor = c.get("actor");
    const criterionId = readId(c, "criterionId", "Acceptance Criterion");
    const existing = await findCriterion(criterionId);
    const scope = await loadTaskScope(db, actor, existing.taskId);
    requireProjectCapability(actor, scope, "edit_task");
    const input = await readJson(c, UpdateAcceptanceCriterionInput);
    const merged = {
      kind: input.kind ?? existing.kind,
      command: input.command !== undefined ? input.command : existing.command,
    };
    if (merged.kind !== "command" && merged.command !== null) {
      throw invalidInput(
        new z.ZodError([
          {
            code: "custom",
            path: ["command"],
            message: "只有 command 類型可以設定指令",
            input: merged.command,
          },
        ]),
      );
    }
    const row = await db.transaction(async (tx) => {
      await lockTask(tx, existing.taskId);
      const [current] = await tx
        .select()
        .from(acceptanceCriteria)
        .where(eq(acceptanceCriteria.id, criterionId));
      if (!current) throw notFound("Acceptance Criterion");
      if (input.position !== undefined && input.position !== current.position) {
        const last = (await criterionCount(tx, current.taskId)) - 1;
        const target = Math.min(input.position, last);
        await movePosition(tx, current.taskId, current.position, target);
        input.position = target;
      }
      const [updated] = await tx
        .update(acceptanceCriteria)
        .set({
          kind: merged.kind,
          command: merged.command,
          ...(input.description !== undefined && { description: input.description }),
          ...(input.position !== undefined && { position: input.position }),
        })
        .where(eq(acceptanceCriteria.id, criterionId))
        .returning();
      return updated;
    });
    if (!row) throw notFound("Acceptance Criterion");
    return c.json(toAcceptanceCriterion(row));
  });

  app.delete("/acceptance-criteria/:criterionId", auth, async (c) => {
    const actor = c.get("actor");
    const criterionId = readId(c, "criterionId", "Acceptance Criterion");
    const existing = await findCriterion(criterionId);
    const scope = await loadTaskScope(db, actor, existing.taskId);
    requireProjectCapability(actor, scope, "edit_task");
    await db.transaction(async (tx) => {
      await lockTask(tx, existing.taskId);
      const [deleted] = await tx
        .delete(acceptanceCriteria)
        .where(eq(acceptanceCriteria.id, criterionId))
        .returning();
      if (!deleted) return;
      await tx
        .update(acceptanceCriteria)
        .set({ position: sql`${acceptanceCriteria.position} - 1` })
        .where(
          and(
            eq(acceptanceCriteria.taskId, deleted.taskId),
            gt(acceptanceCriteria.position, deleted.position),
          ),
        );
    });
    return c.body(null, 204);
  });

  async function findCriterion(criterionId: string) {
    const [row] = await db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.id, criterionId));
    if (!row) throw notFound("Acceptance Criterion");
    return row;
  }

  return app;
}

async function lockTask(tx: Executor, taskId: string): Promise<void> {
  await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).for("update");
}

async function criterionCount(tx: Executor, taskId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.taskId, taskId));
  return row?.n ?? 0;
}

/** 把位置 from 的項目移到 to：中間的項目依方向前後挪一格。 */
async function movePosition(tx: Executor, taskId: string, from: number, to: number) {
  if (to < from) {
    await tx
      .update(acceptanceCriteria)
      .set({ position: sql`${acceptanceCriteria.position} + 1` })
      .where(
        and(
          eq(acceptanceCriteria.taskId, taskId),
          gte(acceptanceCriteria.position, to),
          lt(acceptanceCriteria.position, from),
        ),
      );
  } else {
    await tx
      .update(acceptanceCriteria)
      .set({ position: sql`${acceptanceCriteria.position} - 1` })
      .where(
        and(
          eq(acceptanceCriteria.taskId, taskId),
          gt(acceptanceCriteria.position, from),
          lte(acceptanceCriteria.position, to),
        ),
      );
  }
}

async function requireRepoInProject(tx: Executor, repoId: string, projectId: string) {
  const [repo] = z.uuid().safeParse(repoId).success
    ? await tx
        .select({ id: repos.id })
        .from(repos)
        .where(and(eq(repos.id, repoId), eq(repos.projectId, projectId)))
    : [];
  if (!repo) throw new ApiError(422, "invalid_input", "Repo 不屬於這個 Project");
}

async function requireTeamMember(tx: Executor, actor: Actor, memberId: string) {
  const [member] = z.uuid().safeParse(memberId).success
    ? await tx
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.id, memberId), eq(members.teamId, actor.teamId)))
    : [];
  if (!member) throw new ApiError(422, "invalid_input", "指派對象不是這個 Team 的 Member");
}

async function requireTasksInProject(tx: Executor, taskIds: string[], projectId: string) {
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return;
  if (!ids.every((id) => z.uuid().safeParse(id).success)) {
    throw new ApiError(422, "invalid_input", "相依的 Task 必須在同一個 Project");
  }
  const [row] = await tx
    .select({ n: count() })
    .from(tasks)
    .where(and(inArray(tasks.id, ids), eq(tasks.projectId, projectId)));
  if ((row?.n ?? 0) !== ids.length) {
    throw new ApiError(422, "invalid_input", "相依的 Task 必須在同一個 Project");
  }
}

/** 取代 Task 的相依；拒絕依賴自己與形成循環的相依。 */
async function replaceDependencies(tx: Executor, task: TaskRow, dependsOn: string[]) {
  if (dependsOn.includes(task.id)) {
    throw new ApiError(422, "invalid_input", "Task 不能依賴自己");
  }
  await requireTasksInProject(tx, dependsOn, task.projectId);
  if (dependsOn.length > 0) {
    // 從新的相依往下走（不含新的相依本身，那一層已在上面檢查），走得到這個 Task 自己就是循環。
    const result = await tx.execute<{ found: number }>(sql`
      with recursive reach(id) as (
        select ${taskDependencies.dependsOnTaskId} from ${taskDependencies}
        where ${taskDependencies.taskId} in (${sql.join(
          dependsOn.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        union
        select td.depends_on_task_id from task_dependencies td join reach r on td.task_id = r.id
      )
      select 1 as found from reach where id = ${task.id}::uuid limit 1`);
    const cyclic = result.rows.length > 0;
    if (cyclic) throw new ApiError(422, "invalid_input", "相依關係形成循環");
  }
  await tx.delete(taskDependencies).where(eq(taskDependencies.taskId, task.id));
  if (dependsOn.length > 0) {
    await tx
      .insert(taskDependencies)
      .values(dependsOn.map((d) => ({ taskId: task.id, dependsOnTaskId: d })));
  }
}

/** 找到或建立 Repo 內的 Spec 紀錄。 */
async function upsertSpec(tx: Executor, repoId: string, path: string): Promise<string> {
  const normalized = path.replaceAll("\\", "/");
  const [row] = await tx
    .insert(repoSpecs)
    .values({ repoId, path: normalized })
    .onConflictDoUpdate({
      target: [repoSpecs.repoId, repoSpecs.path],
      set: { updatedAt: new Date() },
    })
    .returning({ id: repoSpecs.id });
  if (!row) throw new Error("建立 Spec 紀錄失敗");
  return row.id;
}
