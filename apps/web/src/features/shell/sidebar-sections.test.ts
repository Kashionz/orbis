import type { NeedsYouItem, Task } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import { matchesSearch, sidebarGroups } from "./sidebar-sections";

function task(id: string, status: Task["status"], title = `Task ${id}`): Task {
  return { id, key: `ORB-${id}`, title, status } as Task;
}

const tasks = [
  task("1", "running", "修正換行"),
  task("2", "review_gate"),
  task("3", "pr_open"),
  task("4", "ready"),
  task("5", "backlog"),
  task("6", "done"),
  task("7", "plan_gate"),
];

describe("sidebarGroups", () => {
  it("依狀態分成進行中、合併請求、就緒、待辦、完成，省略空的分區", () => {
    const groups = sidebarGroups(tasks, [], "");
    expect(groups.map((g) => [g.section, g.rows.map((r) => r.task.key)])).toEqual([
      ["active", ["ORB-1", "ORB-2", "ORB-7"]],
      ["pr", ["ORB-3"]],
      ["ready", ["ORB-4"]],
      ["backlog", ["ORB-5"]],
      ["done", ["ORB-6"]],
    ]);
    expect(sidebarGroups([task("4", "ready")], [], "").map((g) => g.section)).toEqual(["ready"]);
  });

  it("執行中的 Task 閃爍；有待我處理的項目時改用警告色、不閃爍", () => {
    const needs = [{ kind: "permission_request", taskId: "1" }] as unknown as NeedsYouItem[];
    const [active] = sidebarGroups(tasks, needs, "");
    const rows = active?.rows ?? [];
    expect(rows[0]).toMatchObject({ needsYou: true, live: false, dotColor: "var(--od9a845)" });
    expect(rows[1]).toMatchObject({ needsYou: false, live: false });
    expect(sidebarGroups([task("9", "verifying")], [], "")[0]?.rows[0]?.live).toBe(true);
  });

  it("搜尋比對 Task Key 與標題，不分大小寫", () => {
    expect(matchesSearch(task("12", "ready"), "orb-12")).toBe(true);
    expect(matchesSearch(task("1", "ready", "修正換行"), "換行")).toBe(true);
    expect(matchesSearch(task("1", "ready"), "  ")).toBe(true);
    expect(sidebarGroups(tasks, [], "換行").flatMap((g) => g.rows.map((r) => r.task.key))).toEqual([
      "ORB-1",
    ]);
  });
});
