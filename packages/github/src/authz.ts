// GitHub 上的操作者能不能改動 Task（ARCHITECTURE §11「誰的修改算數」）。

import { WRITE_ROLES } from "./client/types";
import { connectedRepo, type IntegrationContext } from "./context";

/**
 * 送出 webhook 的人能不能改動 Task：在 Project 中能編輯 Task 的 Member，
 * 或對 repo 有寫入權限（admin、maintain、write）的人。
 */
export async function senderCanWrite(
  ctx: IntegrationContext,
  projectId: string,
  repoId: string,
  login: string,
  githubUserId: number,
): Promise<boolean> {
  const member = await ctx.domain.findMemberByGithubUserId(projectId, githubUserId);
  if (member && (await ctx.domain.canEditTasks(projectId, member.id))) return true;
  const record = await ctx.domain.getRepo(repoId);
  const repo = record && connectedRepo(record);
  if (!repo) return false;
  const role = await ctx.client.getCollaboratorRole(repo.installationId, repo.ref, {
    login,
    id: githubUserId,
  });
  return WRITE_ROLES.has(role);
}
