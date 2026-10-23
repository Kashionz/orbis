// Task 的 Run 樹（ARCHITECTURE §9「UI」）：依 `parentRunId` 把 Child Run 放到父 Run 底下。

import type { Run } from "@orbis/api-contract";

export interface RunNode {
  run: Run;
  /** 依建立時間排序（舊的在前）。 */
  children: RunNode[];
  /** 從 0 開始；頂層是 0，Child Run 最深是 2。 */
  depth: number;
}

const byCreated = (a: Run, b: Run) => a.createdAt.localeCompare(b.createdAt);

/**
 * 頂層 Run 新的在前，Child Run 舊的在前。父 Run 不在清單中的 Child Run 當成頂層，不會消失。
 * 資料有循環時（不應該發生）以第一次走到的為準，不會無限遞迴。
 */
export function buildRunTree(runs: readonly Run[]): RunNode[] {
  const ids = new Set(runs.map((r) => r.id));
  const childrenOf = new Map<string, Run[]>();
  const roots: Run[] = [];
  for (const run of runs) {
    if (run.parentRunId !== null && ids.has(run.parentRunId)) {
      const list = childrenOf.get(run.parentRunId) ?? [];
      list.push(run);
      childrenOf.set(run.parentRunId, list);
    } else {
      roots.push(run);
    }
  }
  const visited = new Set<string>();
  const build = (run: Run, depth: number): RunNode => {
    visited.add(run.id);
    const children = [...(childrenOf.get(run.id) ?? [])]
      .sort(byCreated)
      .filter((child) => !visited.has(child.id))
      .map((child) => build(child, depth + 1));
    return { run, children, depth };
  };
  return [...roots].sort((a, b) => byCreated(b, a)).map((run) => build(run, 0));
}

/** 樹中所有節點（前序），方便找出選取的節點。 */
export function flattenRunTree(nodes: readonly RunNode[]): RunNode[] {
  return nodes.flatMap((node) => [node, ...flattenRunTree(node.children)]);
}
