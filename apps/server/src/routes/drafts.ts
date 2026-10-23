// Draft Task 與 Task note（ARCHITECTURE §9）。
//
// - Draft Task：Agent 以 `propose_tasks` 提出，人在 Web 上修改、逐筆或批次確認（建立 Backlog 的 Task，
//   之後才同步成 GitHub Issue）、或捨棄。依賴是同一批的 `#<n>` 或既有的 Task Key：
//   - 確認時換成實際的 Task；依賴的 Draft Task 還沒確認時回 409。批次確認依相依順序建立。
//   - 確認後，同一批其他草稿中指向它的 `#<n>` 改寫成新的 Task Key；捨棄時直接移除。
// - Task note：Agent 的 `update_task_note` 與 Feedback Loop 的紀錄，Web 只讀。

import {
  API_ROUTES,
  type ConfirmDraftTasksResponse,
  DraftTaskBatchInput,
  formatTaskKey,
  UpdateDraftTaskInput,
} from "@orbis/api-contract";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { loadProjectScope, loadTaskScope, requireProjectCapability } from "../authz/scope";
import {
  acceptanceCriteria,
  draftTasks,
  projects,
  repos,
  taskDependencies,
  taskNotes,
  tasks,
} from "../db/schema";
import { type Executor, inTransaction, type UnitOfWork } from "../db/tx";
import { toDraftTask, toTask, toTaskNote } from "../http/dto";
import { ApiError, conflict, notFound, readId, readJson } from "../http/errors";
import type { Actor, AppEnv } from "../http/session";
import type { Services } from "../services";

type DraftRow = typeof draftTasks.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

interface DraftCriterion {
  kind: "command" | "agent" | "browser" | "manual";
  description: string;
  command: string | null;
}

export function createDraftRoutes(s: Services): Hono<AppEnv> {
  const { db, auth, events } = s;
  const app = new Hono<AppEnv>();

  app.get(API_ROUTES.projectDraftTasks, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "view");
    const rows = await db
      .select()
      .from(draftTasks)
      .where(
        and(
          eq(draftTasks.projectId, scope.project.id),
          isNull(draftTasks.confirmedAt),
          isNull(draftTasks.dismissedAt),
        ),
      )
      .orderBy(asc(draftTasks.createdAt), asc(draftTasks.batchId), asc(draftTasks.position));
    return c.json(rows.map(toDraftTask));
  });

  app.patch(API_ROUTES.draftTask, auth, async (c) => {
    const actor = c.get("actor");
    const draft = await loadOpenDraft(db, readId(c, "draftTaskId", "Draft Task"));
    const scope = await loadProjectScope(db, actor, draft.projectId);
    requireProjectCapability(actor, scope, "edit_task");
    const input = await readJson(c, UpdateDraftTaskInput);
    if (input.repoId) await requireRepoInProject(db, input.repoId, draft.projectId);
    if (input.dependsOn) await validateDependencies(db, draft, input.dependsOn);
    const [updated] = await db
      .update(draftTasks)
      .set({
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.repoId !== undefined && { repoId: input.repoId }),
        ...(input.acceptanceCriteria !== undefined && {
          acceptanceCriteria: input.acceptanceCriteria,
        }),
        ...(input.dependsOn !== undefined && { dependsOn: input.dependsOn }),
      })
      .where(eq(draftTasks.id, draft.id))
      .returning();
    if (!updated) throw notFound("Draft Task");
    return c.json(toDraftTask(updated));
  });

  app.post(API_ROUTES.draftTaskConfirm, auth, async (c) => {
    const actor = c.get("actor");
    const draft = await loadOpenDraft(db, readId(c, "draftTaskId", "Draft Task"));
    const scope = await loadProjectScope(db, actor, draft.projectId);
    requireProjectCapability(actor, scope, "edit_task");
    const [created] = await inTransaction(db, (uow) => confirmDrafts(uow, actor, [draft.id]));
    if (!created) throw notFound("Draft Task");
    return c.json(await toTask(db, created.task), 201);
  });

  app.post(API_ROUTES.projectDraftTasksConfirm, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "edit_task");
    const input = await readJson(c, DraftTaskBatchInput);
    const ids = [...new Set(input.draftTaskIds)];
    const created = await inTransaction(db, (uow) =>
      confirmDrafts(uow, actor, ids, scope.project.id),
    );
    const byDraft = new Map(created.map((c) => [c.draftTaskId, c.task]));
    const response: ConfirmDraftTasksResponse = [];
    for (const id of ids) {
      const task = byDraft.get(id);
      if (task) response.push({ draftTaskId: id, task: await toTask(db, task) });
    }
    return c.json(response, 201);
  });

  app.post(API_ROUTES.draftTaskDismiss, auth, async (c) => {
    const actor = c.get("actor");
    const draft = await loadOpenDraft(db, readId(c, "draftTaskId", "Draft Task"));
    const scope = await loadProjectScope(db, actor, draft.projectId);
    requireProjectCapability(actor, scope, "edit_task");
    await inTransaction(db, (uow) => dismissDrafts(uow.tx, [draft]));
    return c.body(null, 204);
  });

  app.post(API_ROUTES.projectDraftTasksDismiss, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "edit_task");
    const input = await readJson(c, DraftTaskBatchInput);
    await inTransaction(db, async ({ tx }) => {
      const rows = await tx
        .select()
        .from(draftTasks)
        .where(
          and(
            inArray(draftTasks.id, input.draftTaskIds),
            eq(draftTasks.projectId, scope.project.id),
            isNull(draftTasks.confirmedAt),
            isNull(draftTasks.dismissedAt),
          ),
        )
        .for("update");
      if (rows.length !== new Set(input.draftTaskIds).size) throw notFound("Draft Task");
      await dismissDrafts(tx, rows);
    });
    return c.body(null, 204);
  });

  app.get(API_ROUTES.taskNotes, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireProjectCapability(actor, scope, "view");
    const rows = await db
      .select()
      .from(taskNotes)
      .where(eq(taskNotes.taskId, scope.task.id))
      .orderBy(desc(taskNotes.createdAt), desc(taskNotes.id));
    return c.json(rows.map(toTaskNote));
  });

  /**
   * 確認 Draft Task：依相依順序建立 Task（Backlog），寫入 Acceptance Criterion 與相依，
   * 改寫同一批其他草稿的 `#<n>`。projectId 有值時，所有 Draft Task 都必須在這個 Project。
   */
  async function confirmDrafts(
    uow: UnitOfWork,
    actor: Actor,
    ids: string[],
    projectId?: string,
  ): Promise<{ draftTaskId: string; task: TaskRow }[]> {
    const { tx } = uow;
    const drafts = await tx
      .select()
      .from(draftTasks)
      .where(
        and(
          inArray(draftTasks.id, ids),
          isNull(draftTasks.confirmedAt),
          isNull(draftTasks.dismissedAt),
          projectId ? eq(draftTasks.projectId, projectId) : undefined,
        ),
      )
      .for("update");
    if (drafts.length !== ids.length) throw notFound("Draft Task");
    const ordered = orderByDependencies(drafts);
    const created: { draftTaskId: string; task: TaskRow }[] = [];
    for (const draft of ordered) {
      // 重新讀一次：同一批先建立的 Task 已經把 #<n> 改寫成 Task Key。
      const [current] = await tx.select().from(draftTasks).where(eq(draftTasks.id, draft.id));
      if (!current) throw notFound("Draft Task");
      created.push({ draftTaskId: draft.id, task: await confirmOne(uow, actor, current) });
    }
    return created;
  }

  async function confirmOne(uow: UnitOfWork, actor: Actor, draft: DraftRow): Promise<TaskRow> {
    const { tx } = uow;
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, draft.projectId))
      .for("update");
    if (!project) throw notFound("Project");
    const dependsOn = draft.dependsOn as string[];
    if (dependsOn.some((d) => d.startsWith("#"))) {
      throw conflict("依賴的 Draft Task 還沒確認，請先確認它或一起確認");
    }
    const dependencyRows =
      dependsOn.length > 0
        ? await tx
            .select({ id: tasks.id, key: tasks.key })
            .from(tasks)
            .where(and(eq(tasks.projectId, project.id), inArray(tasks.key, dependsOn)))
        : [];
    if (dependencyRows.length !== new Set(dependsOn).size) {
      throw new ApiError(422, "invalid_input", "依賴的 Task 不在這個 Project 中");
    }
    const number = project.nextTaskNumber;
    await tx
      .update(projects)
      .set({ nextTaskNumber: number + 1 })
      .where(eq(projects.id, project.id));
    const [task] = await tx
      .insert(tasks)
      .values({
        projectId: project.id,
        number,
        key: formatTaskKey(project.taskKeyPrefix, number),
        repoId: draft.repoId,
        title: draft.title,
        description: draft.description,
        createdByMemberId: actor.memberId,
      })
      .returning();
    if (!task) throw new Error("建立 Task 失敗");
    const criteria = draft.acceptanceCriteria as DraftCriterion[];
    if (criteria.length > 0) {
      await tx.insert(acceptanceCriteria).values(
        criteria.map((criterion, position) => ({
          taskId: task.id,
          position,
          kind: criterion.kind,
          description: criterion.description,
          command: criterion.kind === "command" ? criterion.command : null,
        })),
      );
    }
    if (dependencyRows.length > 0) {
      await tx
        .insert(taskDependencies)
        .values(dependencyRows.map((d) => ({ taskId: task.id, dependsOnTaskId: d.id })));
    }
    await tx
      .update(draftTasks)
      .set({
        confirmedTaskId: task.id,
        confirmedByMemberId: actor.memberId,
        confirmedAt: s.clock.now(),
      })
      .where(eq(draftTasks.id, draft.id));
    await rewriteSiblingDependencies(tx, draft, task.key);
    uow.afterCommit(() =>
      events.emit({
        type: "task.created",
        taskId: task.id,
        projectId: task.projectId,
        source: "api",
        actorMemberId: actor.memberId,
      }),
    );
    return task;
  }

  return app;
}

async function loadOpenDraft(db: Executor, id: string): Promise<DraftRow> {
  const [draft] = await db.select().from(draftTasks).where(eq(draftTasks.id, id));
  if (!draft || draft.confirmedAt || draft.dismissedAt) throw notFound("Draft Task");
  return draft;
}

async function requireRepoInProject(db: Executor, repoId: string, projectId: string) {
  const [repo] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.id, repoId), eq(repos.projectId, projectId)));
  if (!repo) throw new ApiError(422, "invalid_input", "Repo 不在這個 Project 中");
}

/** 依賴必須是同一批存在的另一個草稿，或這個 Project 的 Task。 */
async function validateDependencies(db: Executor, draft: DraftRow, dependsOn: string[]) {
  const siblings = await db
    .select({ position: draftTasks.position })
    .from(draftTasks)
    .where(and(eq(draftTasks.batchId, draft.batchId), isNull(draftTasks.dismissedAt)));
  const positions = new Set(siblings.map((s) => s.position));
  const keys = dependsOn.filter((d) => !d.startsWith("#"));
  for (const d of dependsOn.filter((d) => d.startsWith("#"))) {
    const n = Number(d.slice(1));
    if (n === draft.position || !positions.has(n)) {
      throw new ApiError(422, "invalid_input", `依賴 ${d} 不是同一批的其他 Draft Task`);
    }
  }
  if (keys.length > 0) {
    const found = await db
      .select({ key: tasks.key })
      .from(tasks)
      .where(and(eq(tasks.projectId, draft.projectId), inArray(tasks.key, keys)));
    if (found.length !== new Set(keys).size) {
      throw new ApiError(422, "invalid_input", "依賴的 Task 不在這個 Project 中");
    }
  }
}

/** 依同一批的 `#<n>` 排出建立順序（被依賴的先建立）；有循環時回 409。 */
function orderByDependencies(drafts: DraftRow[]): DraftRow[] {
  const byKey = new Map(drafts.map((d) => [`${d.batchId}#${d.position}`, d]));
  const ordered: DraftRow[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (draft: DraftRow) => {
    const mark = state.get(draft.id);
    if (mark === "done") return;
    if (mark === "visiting") throw conflict("Draft Task 的依賴形成循環");
    state.set(draft.id, "visiting");
    for (const d of draft.dependsOn as string[]) {
      const dependency = d.startsWith("#") ? byKey.get(`${draft.batchId}${d}`) : undefined;
      if (dependency) visit(dependency);
    }
    state.set(draft.id, "done");
    ordered.push(draft);
  };
  for (const draft of drafts) visit(draft);
  return ordered;
}

/** 同一批其他草稿中指向 `draft` 的 `#<n>` 換成 replacement；replacement 為 null 時移除。 */
async function rewriteSiblingDependencies(
  tx: Executor,
  draft: DraftRow,
  replacement: string | null,
): Promise<void> {
  const ref = `#${draft.position}`;
  const siblings = await tx
    .select()
    .from(draftTasks)
    .where(
      and(
        eq(draftTasks.batchId, draft.batchId),
        isNull(draftTasks.confirmedAt),
        isNull(draftTasks.dismissedAt),
      ),
    );
  for (const sibling of siblings) {
    const dependsOn = sibling.dependsOn as string[];
    if (!dependsOn.includes(ref)) continue;
    const next = dependsOn.flatMap((d) => (d === ref ? (replacement ? [replacement] : []) : [d]));
    await tx
      .update(draftTasks)
      .set({ dependsOn: [...new Set(next)] })
      .where(eq(draftTasks.id, sibling.id));
  }
}

async function dismissDrafts(tx: Executor, drafts: DraftRow[]): Promise<void> {
  for (const draft of drafts) {
    await tx.update(draftTasks).set({ dismissedAt: new Date() }).where(eq(draftTasks.id, draft.id));
    await rewriteSiblingDependencies(tx, draft, null);
  }
}
