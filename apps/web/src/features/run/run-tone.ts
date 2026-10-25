// Run 與 Task 狀態的顏色（原型的 RS／TS 表）。顏色一律是 token，不寫死。

import type { TaskStatus } from "@orbis/api-contract";
import type { RunStatus } from "@orbis/protocol";

export type Tone = "accent" | "warn" | "success" | "danger" | "muted" | "text";

export const TONE_COLOR: Record<Tone, string> = {
  accent: "var(--o7fb0fa)",
  warn: "var(--od9a845)",
  success: "var(--o4fb86a)",
  danger: "var(--oef6b62)",
  muted: "var(--o8b9098)",
  text: "var(--oe8e9eb)",
};

export function runTone(status: RunStatus): Tone {
  switch (status) {
    case "starting":
    case "running":
    case "verifying":
      return "accent";
    case "awaiting_permission":
    case "rate_limited":
    case "awaiting_gate":
      return "warn";
    case "completed":
      return "success";
    case "failed":
      return "danger";
    default:
      return "muted";
  }
}

export function taskTone(status: TaskStatus): Tone {
  switch (status) {
    case "planning":
    case "running":
    case "verifying":
      return "accent";
    case "plan_gate":
    case "review_gate":
      return "warn";
    case "pr_open":
      return "success";
    default:
      return "muted";
  }
}

/** Run 正在動（顯示閃爍的點）。 */
export function isRunLive(status: RunStatus): boolean {
  return status === "starting" || status === "running" || status === "verifying";
}
