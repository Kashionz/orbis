import type { Run } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import { buildRunTree, flattenRunTree } from "./run-tree";

function run(id: string, createdAt: string, parentRunId: string | null = null): Run {
  return {
    id,
    taskId: "task-1",
    parentRunId,
    delegationMode: parentRunId ? "consult" : null,
    agent: "claude-code",
    model: null,
    permissionPolicy: "auto",
    runnerKind: "local",
    runnerId: null,
    worktreePath: null,
    branch: null,
    baseCommit: null,
    status: "running",
    usage: {
      inputTokens: null,
      outputTokens: null,
      thoughtTokens: null,
      cachedReadTokens: null,
      cachedWriteTokens: null,
      contextUsedTokens: null,
      contextWindowTokens: null,
      cost: null,
    },
    startedByMemberId: null,
    origin: parentRunId ? "delegation" : "dispatch",
    credential: null,
    consultOfRunId: null,
    resumesRunId: null,
    createdAt: `2026-10-24T00:00:0${createdAt}.000Z`,
    startedAt: null,
    endedAt: null,
    updatedAt: `2026-10-24T00:00:0${createdAt}.000Z`,
  };
}

const shape = (nodes: ReturnType<typeof buildRunTree>): unknown =>
  nodes.map((n) => ({ id: n.run.id, depth: n.depth, children: shape(n.children) }));

describe("buildRunTree", () => {
  it("頂層新的在前，Child Run 舊的在前，深度最多兩層", () => {
    const tree = buildRunTree([
      run("a", "1"),
      run("b", "5"),
      run("a2", "3", "a"),
      run("a1", "2", "a"),
      run("a1x", "4", "a1"),
    ]);
    expect(shape(tree)).toEqual([
      { id: "b", depth: 0, children: [] },
      {
        id: "a",
        depth: 0,
        children: [
          { id: "a1", depth: 1, children: [{ id: "a1x", depth: 2, children: [] }] },
          { id: "a2", depth: 1, children: [] },
        ],
      },
    ]);
    expect(flattenRunTree(tree).map((n) => n.run.id)).toEqual(["b", "a", "a1", "a1x", "a2"]);
  });

  it("父 Run 不在清單中時當成頂層", () => {
    expect(shape(buildRunTree([run("c", "1", "missing")]))).toEqual([
      { id: "c", depth: 0, children: [] },
    ]);
  });
});
