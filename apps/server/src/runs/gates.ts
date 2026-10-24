// Gate（ARCHITECTURE §5、§8、§10）：Plan Gate 與 Review Gate 的建立、Needs You 的去向。
//
// - Plan Gate：主 Run 送出 plan（`plan_proposed`）並回報 `awaiting_gate(plan)` 後建立，送審的是當下最新的
//   `plan_proposed`。
// - Review Gate：Verification 全數通過（或人選擇略過失敗）後建立，送審的是當下最新的 `run_diff`。
// - Needs You 指派給 Task 負責人（沒有負責人時給派工者）。Project「不能核准自己的 Task」而負責人在這個
//   Project 的有效 Role 是 Member 時，負責人不能核准，Needs You 不指派給特定的人（member_id 為 null），
//   清單依授權即時計算：Project 中所有能核准的人都看得到。

import type { GateKind } from "@orbis/api-contract";
import type { EventKindName } from "@orbis/protocol";
import { and, desc, eq } from "drizzle-orm";
import { authorize, effectiveRole } from "../authz/capabilities";
import {
  acceptanceCriteria,
  gates,
  members,
  needsYouItems,
  projectMemberRoles,
  projects,
  runEvents,
  type runs,
  tasks,
} from "../db/schema";
import type { Executor, UnitOfWork } from "../db/tx";

type RunRow = typeof runs.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
export type GateRow = typeof gates.$inferSelect;

/** Plan Gate 送審的 Event kind（協定的 `plan_proposed`）。 */
export const PLAN_PROPOSED_EVENT_KIND = "plan_proposed" satisfies EventKindName;
/** Review Gate 送審的 Event kind（協定的 `run_diff`）。 */
export const RUN_DIFF_EVENT_KIND = "run_diff" satisfies EventKindName;
/** Agent 結束回合時的最後回覆（協定的 `final_message`），在 `run_diff` 之前送出。 */
export const FINAL_MESSAGE_EVENT_KIND = "final_message" satisfies EventKindName;

/** gates.subject 的內容。 */
export interface GateSubject {
  /** Plan Gate 送審的 `plan_proposed` 的 seq。 */
  planSeq?: number | null;
  /** Review Gate 送審的 `run_diff` 的 seq。 */
  reviewDiffSeq?: number | null;
  /** 這個 Gate 是被中止的。 */
  aborted?: boolean;
  /** Review Gate 的 diff 為空，以「結束（沒有變更）」結束（decision 為 approved）。 */
  noChanges?: boolean;
}

/** Run 中某種 Event 最新一筆的 seq。 */
export async function latestEventSeq(
  tx: Executor,
  runId: string,
  kind: EventKindName,
): Promise<number | null> {
  const [row] = await tx
    .select({ seq: runEvents.seq })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.kind, kind)))
    .orderBy(desc(runEvents.seq))
    .limit(1);
  return row?.seq ?? null;
}

/**
 * Gate 的 Needs You 要指派給誰；回傳 null 表示不指派給特定的人（依授權即時計算）。
 * 負責人因「不能核准自己的 Task」而不能核准時回傳 null。
 */
export async function gateNeedsYouMember(
  tx: Executor,
  task: Pick<TaskRow, "projectId" | "assigneeMemberId">,
  run: Pick<RunRow, "requestedByMemberId">,
): Promise<string | null> {
  const assignee = task.assigneeMemberId;
  if (!assignee) return run.requestedByMemberId;
  const [project] = await tx
    .select({ forbidSelfApproval: projects.forbidSelfApproval })
    .from(projects)
    .where(eq(projects.id, task.projectId));
  if (!project?.forbidSelfApproval) return assignee;
  const [member] = await tx
    .select({ role: members.role, override: projectMemberRoles.role })
    .from(members)
    .leftJoin(
      projectMemberRoles,
      and(
        eq(projectMemberRoles.memberId, members.id),
        eq(projectMemberRoles.projectId, task.projectId),
      ),
    )
    .where(eq(members.id, assignee));
  if (!member) return run.requestedByMemberId;
  // 只有有效 Role 是 Member 的人受「不能核准自己的 Task」限制（authz/capabilities.ts）。
  return effectiveRole(member.role, member.override) === "member" ? null : assignee;
}

/** 建立 Gate 與它的 Needs You。 */
export async function openGate(
  uow: UnitOfWork,
  kind: GateKind,
  run: RunRow,
  task: TaskRow,
): Promise<GateRow> {
  const { tx } = uow;
  const subject: GateSubject =
    kind === "plan"
      ? { planSeq: await latestEventSeq(tx, run.id, PLAN_PROPOSED_EVENT_KIND) }
      : { reviewDiffSeq: await latestEventSeq(tx, run.id, RUN_DIFF_EVENT_KIND) };
  const [created] = await tx
    .insert(gates)
    .values({
      taskId: task.id,
      runId: run.id,
      kind,
      assigneeMemberIdAtCreation: task.assigneeMemberId,
      subject,
    })
    .returning();
  if (!created) throw new Error("建立 Gate 失敗");
  if (kind === "review") {
    // 每次進入 Review Gate，manual 條件都要針對這一版的修改重新打勾。
    await tx
      .update(acceptanceCriteria)
      .set({ passed: null, checkedAt: null, checkedByMemberId: null })
      .where(and(eq(acceptanceCriteria.taskId, task.id), eq(acceptanceCriteria.kind, "manual")));
  }
  await tx.insert(needsYouItems).values({
    projectId: task.projectId,
    memberId: await gateNeedsYouMember(tx, task, run),
    kind: "gate",
    taskId: task.id,
    runId: run.id,
    gateId: created.id,
  });
  return created;
}

/**
 * Gate 等待核准的通知對象：Needs You 指派的人；沒有指派給特定的人時（負責人不能核准自己的 Task），
 * 是 Project 中所有能核准這個 Gate 的人。
 */
export async function gateRecipients(tx: Executor, gate: GateRow): Promise<string[]> {
  const [item] = await tx
    .select({ memberId: needsYouItems.memberId })
    .from(needsYouItems)
    .where(eq(needsYouItems.gateId, gate.id));
  if (item?.memberId) return [item.memberId];
  const [context] = await tx
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, gate.taskId));
  if (!context) return [];
  const { task, project } = context;
  const candidates = await tx
    .select({ id: members.id, role: members.role, override: projectMemberRoles.role })
    .from(members)
    .leftJoin(
      projectMemberRoles,
      and(
        eq(projectMemberRoles.memberId, members.id),
        eq(projectMemberRoles.projectId, project.id),
      ),
    )
    .where(eq(members.teamId, project.teamId));
  return candidates
    .filter(
      (m) =>
        authorize("approve_gate", {
          memberId: m.id,
          role: effectiveRole(m.role, m.override),
          project: {
            allowMemberTeamRunnerDispatch: project.allowMemberTeamRunnerDispatch,
            forbidSelfApproval: project.forbidSelfApproval,
          },
          task: {
            assigneeMemberId: task.assigneeMemberId,
            gateAssigneeMemberId: gate.assigneeMemberIdAtCreation,
          },
        }).ok,
    )
    .map((m) => m.id);
}
