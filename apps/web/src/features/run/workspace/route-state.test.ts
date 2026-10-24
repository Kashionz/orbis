import { describe, expect, it } from "vitest";
import { pickRun, runRouteView } from "./route-state";

describe("runRouteView", () => {
  it("review 開差異分頁；verification 開 Task 分頁並捲到驗收", () => {
    expect(runRouteView("review", {})).toEqual({ tab: "diff", focus: undefined });
    expect(runRouteView("run", { tab: "verification" })).toEqual({
      tab: "task",
      focus: "verification",
    });
    expect(runRouteView("run", { tab: "preview", focus: "permission-p1" })).toEqual({
      tab: "preview",
      focus: "permission-p1",
    });
    expect(runRouteView("run", { tab: "timeline" })).toEqual({ tab: undefined, focus: undefined });
  });
});

describe("pickRun", () => {
  const run = (
    id: string,
    createdAt: string,
    patch: { parentRunId?: string | null; origin?: "dispatch" | "mention" | "delegation" } = {},
  ) => ({ id, createdAt, parentRunId: null, origin: "dispatch" as const, ...patch });
  const runs = [
    run("r1", "2026-10-25T08:00:00Z"),
    run("r2", "2026-10-25T09:00:00Z"),
    run("child", "2026-10-25T10:00:00Z", { parentRunId: "r2", origin: "delegation" }),
    run("mention", "2026-10-25T11:00:00Z", { origin: "mention" }),
  ];

  it("沒有指定時取最新的主 Run（不含 Child Run 與 @agent 的 consult Run）", () => {
    expect(pickRun(runs, undefined)?.id).toBe("r2");
  });

  it("指定的 Run 在這個 Task 中時用它（Child Run 也可以）；找不到時退回最新的主 Run", () => {
    expect(pickRun(runs, "child")?.id).toBe("child");
    expect(pickRun(runs, "other-task-run")?.id).toBe("r2");
    expect(pickRun([], undefined)).toBeNull();
  });
});
