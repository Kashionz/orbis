import { describe, expect, it } from "vitest";
import { baseName, changeLetter, commentAnchor, diffRows, placeComments } from "./diff-lines";

const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n").concat("\n");
const after = ["a", "b", "c", "D", "e", "f", "g", "h", "i", "j", "k"].join("\n").concat("\n");

describe("diffRows", () => {
  it("產生 hunk 標頭與每一行的舊、新行號", () => {
    const { rows, adds, dels } = diffRows(before, after);
    expect(adds).toBe(2);
    expect(dels).toBe(1);
    expect(rows[0]).toEqual({ kind: "hunk", text: "@@ -1,10 +1,11 @@" });
    expect(rows.slice(1, 6)).toEqual([
      { kind: "ctx", oldLine: 1, newLine: 1, text: "a" },
      { kind: "ctx", oldLine: 2, newLine: 2, text: "b" },
      { kind: "ctx", oldLine: 3, newLine: 3, text: "c" },
      { kind: "del", oldLine: 4, newLine: null, text: "d" },
      { kind: "add", oldLine: null, newLine: 4, text: "D" },
    ]);
    expect(rows.at(-1)).toEqual({ kind: "add", oldLine: null, newLine: 11, text: "k" });
  });

  it("新增的檔案全部是新增的行；沒有變更時沒有任何行", () => {
    const added = diffRows("", "x\ny\n");
    expect(added.rows.filter((r) => r.kind === "add")).toHaveLength(2);
    expect(diffRows("same\n", "same\n").rows).toEqual([]);
  });

  it("距離很遠的修改分成兩個 hunk", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const changed = [...lines];
    changed[1] = "two";
    changed[27] = "twenty-eight";
    const { rows } = diffRows(`${lines.join("\n")}\n`, `${changed.join("\n")}\n`);
    expect(rows.filter((r) => r.kind === "hunk")).toHaveLength(2);
  });
});

describe("留言", () => {
  const { rows } = diffRows(before, after);

  it("刪除的行留在修改前，其他留在修改後", () => {
    const del = rows.find((r) => r.kind === "del");
    const add = rows.find((r) => r.kind === "add");
    const ctx = rows.find((r) => r.kind === "ctx");
    if (!del || del.kind === "hunk" || !add || add.kind === "hunk" || !ctx || ctx.kind === "hunk") {
      throw new Error("缺少測試用的行");
    }
    expect(commentAnchor(del)).toEqual({ side: "old", line: 4 });
    expect(commentAnchor(add)).toEqual({ side: "new", line: 4 });
    expect(commentAnchor(ctx)).toEqual({ side: "new", line: 1 });
  });

  it("留言掛到對應的行；上下文行兩側的行號都算；找不到的放在 outside", () => {
    const comments = [
      { side: "new" as const, line: 4, body: "新的第 4 行" },
      { side: "old" as const, line: 4, body: "舊的第 4 行" },
      { side: "old" as const, line: 2, body: "上下文" },
      { side: "new" as const, line: 99, body: "不在 hunk 內" },
    ];
    const { byRow, outside } = placeComments(rows, comments);
    const at = (body: string) =>
      [...byRow.entries()].find(([, list]) => list.some((c) => c.body === body))?.[0];
    expect(rows[at("新的第 4 行") ?? -1]).toMatchObject({ kind: "add", newLine: 4 });
    expect(rows[at("舊的第 4 行") ?? -1]).toMatchObject({ kind: "del", oldLine: 4 });
    expect(rows[at("上下文") ?? -1]).toMatchObject({ kind: "ctx", oldLine: 2 });
    expect(outside.map((c) => c.body)).toEqual(["不在 hunk 內"]);
  });
});

describe("檔案標示", () => {
  it("變更種類的字母與檔名", () => {
    expect(
      ["added", "modified", "deleted", "renamed"].map((c) => changeLetter(c as "added")),
    ).toEqual(["A", "M", "D", "R"]);
    expect(baseName("apps/web/src/lib/text.ts")).toBe("text.ts");
    expect(baseName("C:\\wt\\a.rs")).toBe("a.rs");
  });
});
