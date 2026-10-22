import { TASK_STATUSES, type TaskStatus } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import {
  canTransition,
  TASK_TRANSITIONS,
  TRANSITION_TRIGGERS,
  type TransitionTrigger,
} from "../src/domain/task-state-machine";

/**
 * 預期的合法轉換，逐條寫出來（不從實作推導），作為狀態機的規格。
 * 格式：`from → to（觸發來源）`。
 */
const EXPECTED = new Set([
  "backlog→ready(manual)",
  "ready→backlog(manual)",
  "ready→planning(dispatch)",
  "planning→running(planning)",
  "planning→plan_gate(run)",
  "plan_gate→running(gate)",
  "plan_gate→planning(gate)",
  "running→verifying(run)",
  "verifying→review_gate(verification)",
  "verifying→running(verification)",
  "review_gate→running(gate)",
  "review_gate→pr_open(gate)",
  "pr_open→done(github)",
  "pr_open→review_gate(github)",
  "done→backlog(github)",
  // Run 失敗或中止：Run 進行中的狀態回到 Ready。
  "planning→ready(run_stopped)",
  "plan_gate→ready(run_stopped)",
  "running→ready(run_stopped)",
  "verifying→ready(run_stopped)",
  "review_gate→ready(run_stopped)",
  // Issue 關閉：Done 以外的狀態都可以轉 Done。
  "backlog→done(github)",
  "ready→done(github)",
  "planning→done(github)",
  "plan_gate→done(github)",
  "running→done(github)",
  "verifying→done(github)",
  "review_gate→done(github)",
]);

const label = (from: TaskStatus, to: TaskStatus, trigger: TransitionTrigger) =>
  `${from}→${to}(${trigger})`;

describe("Task 狀態機", () => {
  it("轉換表沒有重複的項目", () => {
    const labels = TASK_TRANSITIONS.map((t) => label(t.from, t.to, t.trigger));
    expect(new Set(labels).size).toBe(labels.length);
  });

  // 9 個狀態 × 9 個狀態 × 每種觸發來源：只有 EXPECTED 中的組合合法，其餘一律拒絕。
  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      for (const trigger of TRANSITION_TRIGGERS) {
        const name = label(from, to, trigger);
        const legal = EXPECTED.has(name);
        it(`${name} ${legal ? "合法" : "被拒絕"}`, () => {
          expect(canTransition(from, to, trigger)).toBe(legal);
        });
      }
    }
  }

  it("手動轉換只有 Backlog 與 Ready 之間", () => {
    const manual = TASK_TRANSITIONS.filter((t) => t.trigger === "manual").map((t) =>
      label(t.from, t.to, t.trigger),
    );
    expect(manual.sort()).toEqual(["backlog→ready(manual)", "ready→backlog(manual)"]);
  });
});
