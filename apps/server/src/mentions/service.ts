// @mention（ARCHITECTURE §12.3）：Task 留言、diff 行內留言與共同編輯文件中的 @member 與 @agent。
//
// - 以 mentions 的 (source_kind, source_id, node_id) 去除重複：留言修改、文件存檔時只處理新出現的 mention。
//   留言的 node_id 是被提及對象（formatMentionTargetId），文件的是 mention 節點的 nodeId。
// - @member：通知被提及的人（必須是同一個 Team 的 Member）。
// - @agent：在 Task 上建立一個 `consult` Run，prompt 帶入留言與 Task 的上下文：
//   - 指定了要讀的 Run（diff 行內留言），或 Task 有保留 Worktree 的主 Run，而且那個 Run 在 Team Runner 或
//     留言者自己的 Local Runner 上時，唯讀讀那個 Worktree，派給那個 Run 所在的 Runner。
//   - 否則派到留言者自己的 Local Runner，從 base ref 開唯讀的 Worktree（不在別人的電腦上跑）。
//   - Run 一律記在留言者名下。
//   - 留言者要能派工（Viewer 的 @agent 只記錄，不建立 Run）。Repo Spec 草稿沒有 Task，@agent 只記錄。
// - consult Run 結束後，Agent 最後的回覆貼回成 Task 留言（作者是那個 Run，見 runs/event-ingest.ts）。

import {
  formatMentionTargetId,
  type MentionSource,
  type MentionTarget,
  parseMentions,
  parseMentionTargetId,
} from "@orbis/api-contract";
import type { ContentBlock } from "@orbis/protocol";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { authorize, effectiveRole } from "../authz/capabilities";
import { members, mentions, projectMemberRoles, projects, runs, type tasks } from "../db/schema";
import type { Executor, UnitOfWork } from "../db/tx";
import type { Logger } from "../logger";
import type { Notify } from "../notifications/types";
import type { Dispatcher } from "../runner/dispatcher";
import { buildPrompt } from "../runner/dispatcher";

type TaskRow = typeof tasks.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MentionSourceRef {
  kind: MentionSource;
  /** task_comments.id、review_comments.id，或 collab_documents.name。 */
  id: string;
}

/** 一個要處理的 mention。 */
export interface MentionInput {
  target: MentionTarget;
  label: string;
  nodeId: string;
}

export interface MentionContext {
  /** 所屬的 Project（被提及的 Member 必須在這個 Project 的 Team）。 */
  projectId: string;
  /** 所屬的 Task；Repo Spec 草稿為 null。 */
  task: TaskRow | null;
  /** 留言或修改的人；共同編輯文件中無法確定時為 null（不建立 Run）。 */
  actorMemberId: string | null;
  /** 給 Agent 看的留言內容。 */
  text: string;
  /** diff 行內留言：讀這個 Run 的 Worktree，並附上檔案與行號。 */
  consultOfRunId?: string | null;
  location?: { path: string; line: number } | null;
}

export class MentionService {
  constructor(
    private readonly deps: {
      notify: Notify;
      dispatcher: Dispatcher;
      logger: Logger;
    },
  ) {}

  /** 文字（留言）中的 mention；同一則留言對同一個對象只算一次。回傳這次建立的 consult Run。 */
  async processText(
    uow: UnitOfWork,
    source: MentionSourceRef,
    context: MentionContext,
  ): Promise<string[]> {
    const seen = new Set<string>();
    const inputs: MentionInput[] = [];
    for (const match of parseMentions(context.text)) {
      const nodeId = formatMentionTargetId(match.target);
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      inputs.push({ target: match.target, label: match.label, nodeId });
    }
    return this.process(uow, source, context, inputs);
  }

  /**
   * 共同編輯文件中的 mention 節點（attrs：id、label、nodeId）。每個節點以加入它的人為準；
   * 不知道是誰加的節點（例如由描述重建的文件）仍會通知 @member，但不建立 @agent 的 Run。
   */
  async processNodes(
    uow: UnitOfWork,
    source: MentionSourceRef,
    context: Omit<MentionContext, "actorMemberId">,
    nodes: { id: string; label: string; nodeId: string; authorMemberId: string | null }[],
  ): Promise<string[]> {
    const created: string[] = [];
    for (const node of nodes) {
      const target = parseMentionTargetId(node.id);
      if (!target || !node.nodeId) continue;
      created.push(
        ...(await this.process(uow, source, { ...context, actorMemberId: node.authorMemberId }, [
          { target, label: node.label, nodeId: node.nodeId },
        ])),
      );
    }
    return created;
  }

  private async process(
    uow: UnitOfWork,
    source: MentionSourceRef,
    context: MentionContext,
    inputs: MentionInput[],
  ): Promise<string[]> {
    const { tx } = uow;
    const created: string[] = [];
    const teamId = await teamOf(tx, context.projectId);
    if (!teamId) return created;
    for (const input of inputs) {
      if (input.target.type === "member") {
        // 只記錄同一個 Team 的 Member（不能用 mention 探測別的 Team 的人）。
        if (!UUID.test(input.target.memberId)) continue;
        const [member] = await tx
          .select({ id: members.id })
          .from(members)
          .where(and(eq(members.id, input.target.memberId), eq(members.teamId, teamId)));
        if (!member) continue;
      }
      const [row] = await tx
        .insert(mentions)
        .values({
          taskId: context.task?.id ?? null,
          sourceKind: source.kind,
          sourceId: source.id,
          nodeId: input.nodeId,
          memberId: input.target.type === "member" ? input.target.memberId : null,
          agent: input.target.type === "agent" ? input.target.agent : null,
          createdByMemberId: context.actorMemberId,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) continue;
      if (input.target.type === "member") {
        await this.deps.notify.notify(uow, {
          kind: "mentioned",
          recipients: [input.target.memberId],
          taskId: context.task?.id ?? null,
          actorMemberId: context.actorMemberId,
          title: context.task ? `${context.task.key} 有人提到你` : "Spec 草稿中有人提到你",
          body: context.text.slice(0, 500),
        });
        continue;
      }
      if (!context.task || !context.actorMemberId) continue;
      const runId = await this.createConsultRun(uow, input.target.agent, context.task, {
        ...context,
        actorMemberId: context.actorMemberId,
      });
      if (!runId) continue;
      await tx.update(mentions).set({ consultRunId: runId }).where(eq(mentions.id, row.id));
      created.push(runId);
    }
    return created;
  }

  /** @agent 建立 consult Run；留言者不能派工時回傳 null。 */
  private async createConsultRun(
    uow: UnitOfWork,
    agent: string,
    task: TaskRow,
    context: MentionContext & { actorMemberId: string },
  ): Promise<string | null> {
    const { tx } = uow;
    const source = context.consultOfRunId
      ? (await tx.select().from(runs).where(eq(runs.id, context.consultOfRunId)))[0]
      : (
          await tx
            .select()
            .from(runs)
            .where(
              and(
                eq(runs.taskId, task.id),
                isNull(runs.parentRunId),
                isNotNull(runs.worktreePath),
                isNotNull(runs.runnerId),
              ),
            )
            .orderBy(desc(runs.createdAt))
            .limit(1)
        )[0];
    // 只沿用 Team Runner 或留言者自己的 Local Runner 上的 Worktree：不在別人的電腦上替留言者跑 Agent。
    const usable =
      source && (source.target === "team" || source.requestedByMemberId === context.actorMemberId)
        ? source
        : undefined;
    const target = usable?.target ?? "local";
    if (!(await this.canDispatch(tx, task, context.actorMemberId, target))) return null;
    const prompt = await mentionPrompt(tx, task, context);
    const [run] = await tx
      .insert(runs)
      .values({
        taskId: task.id,
        delegationMode: "consult",
        agent,
        permissionPolicy: "auto",
        target,
        requestedByMemberId: context.actorMemberId,
        origin: "mention",
        consultOfRunId: usable?.id ?? null,
        prompt,
        promptSource: "user",
      })
      .returning({ id: runs.id });
    if (!run) return null;
    uow.afterCommit(() => void this.deps.dispatcher.kick());
    return run.id;
  }

  private async canDispatch(
    tx: Executor,
    task: TaskRow,
    memberId: string,
    target: "local" | "team",
  ): Promise<boolean> {
    const [row] = await tx
      .select({ member: members, project: projects, override: projectMemberRoles.role })
      .from(members)
      .innerJoin(projects, eq(projects.teamId, members.teamId))
      .leftJoin(
        projectMemberRoles,
        and(
          eq(projectMemberRoles.memberId, members.id),
          eq(projectMemberRoles.projectId, projects.id),
        ),
      )
      .where(and(eq(members.id, memberId), eq(projects.id, task.projectId)));
    if (!row) return false;
    return authorize(target === "local" ? "dispatch_local" : "dispatch_team", {
      memberId,
      role: effectiveRole(row.member.role, row.override),
      project: {
        allowMemberTeamRunnerDispatch: row.project.allowMemberTeamRunnerDispatch,
        forbidSelfApproval: row.project.forbidSelfApproval,
      },
    }).ok;
  }
}

async function teamOf(tx: Executor, projectId: string): Promise<string | null> {
  const [project] = await tx
    .select({ teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, projectId));
  return project?.teamId ?? null;
}

/** @agent 的 prompt：留言（含檔案與行號）與 Task 的上下文。 */
async function mentionPrompt(
  tx: Executor,
  task: TaskRow,
  context: MentionContext,
): Promise<ContentBlock[]> {
  const where = context.location
    ? `在 diff 的 ${context.location.path}:${context.location.line} 留言`
    : `在 Task ${task.key} 的留言`;
  const lines = [
    `你${where}中被提及。請以唯讀的方式查看程式碼後回覆，不要修改任何檔案。`,
    "",
    "留言：",
    context.text,
  ];
  const taskBlocks = await buildPrompt(tx, task);
  return [{ type: "text", text: lines.join("\n") }, ...taskBlocks];
}
