// CI 修正 prompt 的細節：每個失敗 check 的 log 摘要（ARCHITECTURE §5.2「附上失敗的 check 名稱與 log 摘要」）。
//
// - GitHub Actions：讀 job log（需要 App 的 `actions: read`），只擷取失敗的段落。
// - 沒有權限、log 不存在、或不是 GitHub Actions 的 check：退回 failure 等級的 annotations
//   （check 的 output 一律由 prompt.ts 附上）。

import { GitHubApiError, type GitHubCheckAnnotation } from "../client/types";
import { type ConnectedRepo, connectedRepo, type IntegrationContext } from "../context";
import type { CiFeedbackItem, PullRequestLink } from "../ports";
import { extractFailureExcerpt, FAILURE_EXCERPT_MAX_CHARS, limitTail } from "./ci-log";
import { codeBlock } from "./prompt";

/** 一批 CI 回饋的細節加起來最多幾個字元（超過的 check 只附 output 與連結）。 */
export const CI_DETAILS_MAX_CHARS = 12_000;
/** 每個 check 的標題與 code fence 預留的字元數。 */
const HEADER_RESERVE = 200;
/** 每個 check 最多附幾則 annotation。 */
const MAX_ANNOTATIONS = 20;

const GITHUB_ACTIONS = "github-actions";

/** 一個 check 的內容最多幾個字元：每個 check 的上限與這批剩下的預算取小。 */
function contentLimit(budget: number): number {
  return Math.max(0, Math.min(FAILURE_EXCERPT_MAX_CHARS, budget));
}

async function actionsLogDetails(
  ctx: IntegrationContext,
  repo: ConnectedRepo,
  item: CiFeedbackItem,
  budget: number,
): Promise<string | null> {
  let log: string | null;
  try {
    log = await ctx.client.getActionsJobLog(repo.installationId, repo.ref, item.checkRunId);
  } catch (error) {
    if (!(error instanceof GitHubApiError)) throw error;
    ctx.logger.warn(
      { checkRunId: item.checkRunId, status: error.status },
      error.status === 403
        ? "讀不到 GitHub Actions 的 log（App 沒有 actions: read 權限），改用 annotations"
        : "讀取 GitHub Actions 的 log 失敗，改用 annotations",
    );
    return null;
  }
  if (!log) return null;
  const excerpt = extractFailureExcerpt(log);
  if (excerpt.lines.length === 0) return null;
  const heading = excerpt.step
    ? `失敗的步驟 \`${excerpt.step.replace(/`/g, "'")}\` 的 log（${excerpt.truncated ? "最後" : "全部"} ${excerpt.lines.length} 行）：`
    : `log 的最後 ${excerpt.lines.length} 行：`;
  // 先截斷內容再包 code block，外框一定保留。
  const content = limitTail(excerpt.lines.join("\n"), contentLimit(budget));
  return `${heading}\n\n${codeBlock(content)}`;
}

function formatAnnotation(a: GitHubCheckAnnotation): string {
  const line =
    a.startLine === null
      ? ""
      : a.endLine !== null && a.endLine !== a.startLine
        ? `:${a.startLine}-${a.endLine}`
        : `:${a.startLine}`;
  return `${a.path}${line}: ${a.title ? `${a.title}: ` : ""}${a.message}`;
}

async function annotationDetails(
  ctx: IntegrationContext,
  repo: ConnectedRepo,
  item: CiFeedbackItem,
  budget: number,
): Promise<string | null> {
  const annotations = (
    await ctx.client.listCheckRunAnnotations(repo.installationId, repo.ref, item.checkRunId)
  ).filter((a) => a.level === "failure");
  if (annotations.length === 0) return null;
  const shown = annotations.slice(0, MAX_ANNOTATIONS).map(formatAnnotation);
  if (annotations.length > shown.length) {
    shown.push(`…還有 ${annotations.length - shown.length} 則`);
  }
  const content = limitTail(shown.join("\n"), contentLimit(budget));
  return `失敗的 annotations：\n\n${codeBlock(content)}`;
}

/** 每個失敗 check 的細節（markdown），以 check run id 為 key。讀不到細節的 check 不放。 */
export async function collectCiDetails(
  ctx: IntegrationContext,
  link: PullRequestLink,
  items: readonly CiFeedbackItem[],
): Promise<Map<number, string>> {
  const details = new Map<number, string>();
  const record = await ctx.domain.getRepo(link.repoId);
  const repo = record && connectedRepo(record);
  if (!repo) return details;
  let budget = CI_DETAILS_MAX_CHARS;
  for (const item of items) {
    // 標題與 code fence 另外留 HEADER_RESERVE 個字元
    if (budget <= HEADER_RESERVE) break;
    const text =
      (item.appSlug === GITHUB_ACTIONS
        ? await actionsLogDetails(ctx, repo, item, budget - HEADER_RESERVE)
        : null) ?? (await annotationDetails(ctx, repo, item, budget - HEADER_RESERVE));
    if (!text) continue;
    details.set(item.checkRunId, text);
    budget -= text.length;
  }
  return details;
}
