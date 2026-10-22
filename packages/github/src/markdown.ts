// 寫到 GitHub 上的 markdown：Issue 的狀態摘要留言與 PR 的 body。

import { NAMES, type TaskStatus } from "@orbis/api-contract";
import type { AcceptanceCriterionRecord, RunSummary, TaskRecord } from "./ports";

/** 狀態摘要留言的隱藏標記，用來辨認哪一則留言是 App 維護的。 */
export const SUMMARY_MARKER = `<!-- ${NAMES.productSlug}:summary -->`;
/** PR body 的隱藏標記。 */
export const PULL_REQUEST_MARKER = `<!-- ${NAMES.productSlug}:pull-request -->`;

/** PR body 中 Spec 摘要的長度上限（字元）。 */
export const SPEC_SUMMARY_MAX_CHARS = 1500;

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  planning: "Planning",
  plan_gate: "Plan Gate",
  running: "Running",
  verifying: "Verifying",
  review_gate: "Review Gate",
  pr_open: "PR Open",
  done: "Done",
};

const RESULT_LABELS: Record<AcceptanceCriterionRecord["result"], string> = {
  passed: "✅ 通過",
  failed: "❌ 失敗",
  pending: "⏳ 未判定",
};

/** 放進表格的一格：去掉換行、跳脫 `|`。 */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function criteriaTable(criteria: readonly AcceptanceCriterionRecord[]): string {
  if (criteria.length === 0) return "_沒有 Acceptance Criterion。_";
  const rows = criteria.map(
    (c) => `| ${cell(c.description)} | \`${c.kind}\` | ${RESULT_LABELS[c.result]} |`,
  );
  return ["| Acceptance Criterion | 類型 | 結果 |", "|---|---|---|", ...rows].join("\n");
}

export function renderSummaryComment(input: {
  task: TaskRecord;
  taskUrl: string;
  criteria: readonly AcceptanceCriterionRecord[];
  latestRun: RunSummary | null;
  /** 要特別提醒的事，例如「Issue 被關閉，但 Task 有進行中的 Run」。 */
  notice?: string;
}): string {
  const { task } = input;
  const lines = [
    SUMMARY_MARKER,
    `### ${NAMES.productName} · [${task.key}](${input.taskUrl})`,
    "",
    `**狀態**：${TASK_STATUS_LABELS[task.status]}${task.doneReason === "not_planned" ? "（不處理）" : ""}`,
  ];
  if (input.latestRun) {
    lines.push(`**最近的 Run**：${input.latestRun.agent} · ${input.latestRun.status}`);
  }
  lines.push("", criteriaTable(input.criteria));
  if (input.notice) lines.push("", `> [!WARNING]`, `> ${cell(input.notice)}`);
  lines.push(
    "",
    `<sub>這則留言由 ${NAMES.productName} 自動維護，請不要編輯；Spec 與 Acceptance Criterion 請到 ${NAMES.productName} 修改。</sub>`,
  );
  return lines.join("\n");
}

/** Spec 摘要：Task 描述的開頭，超過上限時截斷。 */
export function specSummary(description: string): string {
  const text = description.replace(/\r\n/g, "\n").trim();
  if (text.length <= SPEC_SUMMARY_MAX_CHARS) return text;
  return `${text.slice(0, SPEC_SUMMARY_MAX_CHARS).trimEnd()}…`;
}

export function pullRequestTitle(task: Pick<TaskRecord, "key" | "title">): string {
  return `${task.key} ${task.title}`;
}

export function renderPullRequestBody(input: {
  task: TaskRecord;
  taskUrl: string;
  criteria: readonly AcceptanceCriterionRecord[];
  /** Repo 內 Spec 檔在 GitHub 上的網址。 */
  specUrl: string | null;
  /** 對應的 Issue 編號（同一個 repo）；merge 時由 GitHub 自動關閉。 */
  issueNumber: number | null;
}): string {
  const { task } = input;
  const lines = [
    PULL_REQUEST_MARKER,
    `由 ${NAMES.productName} 在 Review Gate 核准後開出。Task：[${task.key}](${input.taskUrl})`,
    "",
    "## Spec",
    "",
  ];
  if (input.specUrl && task.specPath)
    lines.push(`Spec 檔：[\`${task.specPath}\`](${input.specUrl})`, "");
  lines.push(specSummary(task.description) || "_Task 沒有描述。_");
  lines.push("", "## Acceptance Criterion", "", criteriaTable(input.criteria));
  if (input.issueNumber !== null) lines.push("", `Closes #${input.issueNumber}`);
  return lines.join("\n");
}
