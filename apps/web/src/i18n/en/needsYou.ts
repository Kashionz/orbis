import type { Messages } from "../types";

export default {
  title: "Needs you",
  empty: "All caught up",
  group: {
    permission: "Permission requests",
    plan_gate: "Plan gate",
    review_gate: "Review gate",
    stopped_run: "Stopped runs",
    child_question: "Child run questions",
  },
  summary: {
    plan_gate: "Plan awaiting approval",
    review_gate: "Diff awaiting review",
  },
  go: {
    permission: "Open run",
    plan_gate: "View plan",
    review_gate: "Review diff",
    stopped_run: "Decide",
    child_question: "Open child run",
  },
  stoppedReason: {
    verification_limit: (attempt: number | null) =>
      attempt === null
        ? "Verification kept failing, over the retry limit"
        : `Verification failed ${attempt} times in a row, over the retry limit`,
    push_failed: "Pushing the branch failed",
    pr_open_failed: "Opening the PR failed",
    local_merge_blocked: "Local merge was blocked",
  },
  stoppedWithDetail: (reason: string, detail: string) => `${reason}: ${detail}`,
  answer: "Answer",
  answerLabel: (key: string) => `Answer the child run of ${key}`,
  answerPlaceholder: "Answer the child run’s question",
  retryLocalMerge: "Retry merge",
} satisfies Messages["needsYou"];
