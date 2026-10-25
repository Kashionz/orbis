// 差異分頁的行格（純函式）：一個檔案修改前後的內容 → hunk 標頭與每一行（舊、新行號、+/−），
// 並把行內留言掛到對應的行上。

import type { ReviewCommentInput } from "@orbis/api-contract";
import { structuredPatch } from "diff";

/** 每個 hunk 前後保留的上下文行數。 */
const CONTEXT_LINES = 3;

export type DiffRow =
  | { kind: "hunk"; text: string }
  | {
      kind: "add" | "del" | "ctx";
      /** 修改前的行號；新增的行為 null。 */
      oldLine: number | null;
      /** 修改後的行號；刪除的行為 null。 */
      newLine: number | null;
      text: string;
    };

export type CodeRow = Exclude<DiffRow, { kind: "hunk" }>;

export interface FileDiff {
  rows: DiffRow[];
  adds: number;
  dels: number;
}

/** 修改前後的內容 → 行格。新增的檔案修改前為空字串，刪除的檔案修改後為空字串。 */
export function diffRows(before: string, after: string): FileDiff {
  const patch = structuredPatch("a", "b", before, after, "", "", { context: CONTEXT_LINES });
  const rows: DiffRow[] = [];
  let adds = 0;
  let dels = 0;
  for (const hunk of patch.hunks) {
    rows.push({
      kind: "hunk",
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const sign = line[0];
      const text = line.slice(1);
      if (sign === "+") {
        rows.push({ kind: "add", oldLine: null, newLine, text });
        newLine += 1;
        adds += 1;
      } else if (sign === "-") {
        rows.push({ kind: "del", oldLine, newLine: null, text });
        oldLine += 1;
        dels += 1;
      } else if (sign === " ") {
        rows.push({ kind: "ctx", oldLine, newLine, text });
        oldLine += 1;
        newLine += 1;
      }
      // `\ No newline at end of file` 不是內容
    }
  }
  return { rows, adds, dels };
}

/** 在這一行留言時的位置：刪除的行留在修改前，其他留在修改後。 */
export function commentAnchor(row: CodeRow): { side: "old" | "new"; line: number } {
  if (row.kind === "del") return { side: "old", line: row.oldLine as number };
  return { side: "new", line: row.newLine as number };
}

/** 這一行是不是留言所在的位置（上下文行兩側的行號都算）。 */
function rowMatches(row: CodeRow, comment: Pick<ReviewCommentInput, "side" | "line">): boolean {
  if (comment.side === "new") return row.kind !== "del" && row.newLine === comment.line;
  return row.kind !== "add" && row.oldLine === comment.line;
}

export interface PlacedComments<C> {
  /** 行格的 index → 掛在那一行底下的留言。 */
  byRow: Map<number, C[]>;
  /** 對應的行不在顯示的 hunk 中的留言（顯示在檔案最上方）。 */
  outside: C[];
}

/** 把留言掛到行格上。 */
export function placeComments<C extends Pick<ReviewCommentInput, "side" | "line">>(
  rows: readonly DiffRow[],
  comments: readonly C[],
): PlacedComments<C> {
  const byRow = new Map<number, C[]>();
  const outside: C[] = [];
  for (const comment of comments) {
    const index = rows.findIndex((row) => row.kind !== "hunk" && rowMatches(row, comment));
    if (index < 0) {
      outside.push(comment);
      continue;
    }
    const list = byRow.get(index);
    if (list) list.push(comment);
    else byRow.set(index, [comment]);
  }
  return { byRow, outside };
}

/** 檔案的變更種類在檔案分頁上的字母。 */
export function changeLetter(change: "added" | "modified" | "deleted" | "renamed"): string {
  switch (change) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}

/** 路徑的檔名部分。 */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
