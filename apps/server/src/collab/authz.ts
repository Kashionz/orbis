// 共同編輯文件的權限（ARCHITECTURE §12.1、§12.2）：沿用 Role。
// 能查看 Task（或 Repo 所屬的 Project）就能讀；能編輯 Task 才能寫。

import { eq } from "drizzle-orm";
import { authorize } from "../authz/capabilities";
import { loadProjectScope, loadTaskScope, type ProjectScope } from "../authz/scope";
import type { Database } from "../db/client";
import { acceptanceCriteria, repoSpecs, repos } from "../db/schema";
import { forbidden, notFound } from "../http/errors";
import type { Actor } from "../http/session";
import type { CollabDocRef } from "./doc-name";

export type CollabAccess = "read" | "write";

/**
 * Actor 對文件的權限。找不到文件所屬的資源、或不在 Actor 的 Team 時丟出 404；
 * 不能查看時丟出 403。
 */
export async function collabAccess(
  db: Database,
  actor: Actor,
  ref: CollabDocRef,
): Promise<CollabAccess> {
  const scope = await loadDocScope(db, actor, ref);
  const input = {
    memberId: actor.memberId,
    role: scope.role,
    project: {
      allowMemberTeamRunnerDispatch: scope.project.allowMemberTeamRunnerDispatch,
      forbidSelfApproval: scope.project.forbidSelfApproval,
    },
  };
  const view = authorize("view", input);
  if (!view.ok) throw forbidden(view.reason);
  return authorize("edit_task", input).ok ? "write" : "read";
}

async function loadDocScope(db: Database, actor: Actor, ref: CollabDocRef): Promise<ProjectScope> {
  switch (ref.kind) {
    case "task-description":
      return loadTaskScope(db, actor, ref.id);
    case "acceptance-criterion": {
      const [criterion] = await db
        .select({ taskId: acceptanceCriteria.taskId })
        .from(acceptanceCriteria)
        .where(eq(acceptanceCriteria.id, ref.id));
      if (!criterion) throw notFound("Acceptance Criterion");
      return loadTaskScope(db, actor, criterion.taskId);
    }
    case "repo-spec-draft": {
      const [spec] = await db
        .select({ projectId: repos.projectId })
        .from(repoSpecs)
        .innerJoin(repos, eq(repos.id, repoSpecs.repoId))
        .where(eq(repoSpecs.id, ref.id));
      if (!spec) throw notFound("Repo Spec");
      return loadProjectScope(db, actor, spec.projectId);
    }
  }
}
