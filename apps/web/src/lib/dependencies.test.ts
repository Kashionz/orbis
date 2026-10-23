import type { Task, TaskStatus } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import { unfinishedDependencies } from "./dependencies";

const task = (id: string, status: TaskStatus, dependsOn: string[] = []) =>
  ({ id, key: `ORB-${id}`, status, dependsOn }) as Task;

describe("unfinishedDependencies", () => {
  const tasks = [task("1", "done"), task("2", "running"), task("3", "backlog")];

  it("列出還沒有 Done 的依賴", () => {
    expect(
      unfinishedDependencies(task("9", "ready", ["1", "2", "3"]), tasks).map((t) => t.id),
    ).toEqual(["2", "3"]);
  });

  it("依賴都 Done 或找不到時為空", () => {
    expect(unfinishedDependencies(task("9", "ready", ["1", "404"]), tasks)).toEqual([]);
    expect(unfinishedDependencies(task("9", "ready"), tasks)).toEqual([]);
  });
});
