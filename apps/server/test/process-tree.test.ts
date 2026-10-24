// 完整系統 e2e 用的程序樹（e2e/process-tree.ts）：Windows 上父 PID 被重用時，不把無關的程序
// 當成子孫；也以真實的子程序確認目前平台上找得到子孫程序。

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  aliveIn,
  aliveProcesses,
  descendants,
  descendantsIn,
  parseProcessTable,
  processTree,
} from "../e2e/process-tree";

describe("descendantsIn", () => {
  it("依 ppid 找出所有子孫程序", () => {
    const table = [
      { pid: 10, ppid: 1, created: 100 },
      { pid: 11, ppid: 10, created: 110 },
      { pid: 12, ppid: 11, created: 120 },
      { pid: 13, ppid: 10, created: 130 },
      { pid: 20, ppid: 1, created: 105 },
    ];
    expect(descendantsIn(table, 10)).toEqual([11, 13, 12]);
  });

  it("比父 PID 目前的程序還早建立的程序不算子孫（舊父程序已結束、PID 被重用）", () => {
    // postgres.exe（300）由早已結束的 pg_ctl（PID 50）啟動；之後 PID 50 被重用成 stack 的 Runner
    const table = [
      { pid: 300, ppid: 50, created: 1_000 },
      { pid: 301, ppid: 300, created: 1_010 },
      { pid: 302, ppid: 300, created: 1_020 },
      { pid: 40, ppid: 1, created: 5_000 },
      { pid: 50, ppid: 40, created: 5_100 },
      { pid: 51, ppid: 50, created: 5_200 },
    ];
    expect(descendantsIn(table, 40)).toEqual([50, 51]);
  });

  it("沒有建立時間時（macOS／Linux 的 ps）只看 ppid", () => {
    const table = [
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
    ];
    expect(descendantsIn(table, 1)).toEqual([2, 3]);
  });

  it("程序表中有循環時不會無限迴圈", () => {
    const table = [
      { pid: 2, ppid: 3 },
      { pid: 3, ppid: 2 },
    ];
    expect(descendantsIn(table, 2)).toEqual([3]);
  });
});

describe("aliveIn", () => {
  it("PID 相同但建立時間不同（PID 被重用）時不算還在執行", () => {
    const recorded = [
      { pid: 10, ppid: 1, created: 100 },
      { pid: 11, ppid: 10, created: 110 },
      { pid: 12, ppid: 10, created: 120 },
    ];
    const now = [
      { pid: 11, ppid: 10, created: 110 },
      { pid: 12, ppid: 99, created: 900 },
    ];
    expect(aliveIn(now, recorded).map((entry) => entry.pid)).toEqual([11]);
  });

  it("沒有建立時間時只看 PID", () => {
    expect(
      aliveIn(
        [{ pid: 3, ppid: 1 }],
        [
          { pid: 3, ppid: 2 },
          { pid: 4, ppid: 2 },
        ],
      ),
    ).toEqual([{ pid: 3, ppid: 2 }]);
  });
});

describe("parseProcessTable", () => {
  it("解析 tab 分隔的欄位，建立時間與名稱可以是空的，名稱可以有空白", () => {
    const raw = [
      "4\t0\t\tSystem",
      "7692\t8116\t134058000000000000\tcmd.exe",
      "12\t1\t\t/Applications/Some App.app/Contents/MacOS/Some App",
      "13\t1\t\t",
      "",
      "不是程序\t1",
    ].join("\r\n");
    expect(parseProcessTable(raw)).toEqual([
      { pid: 4, ppid: 0, name: "System" },
      { pid: 7692, ppid: 8116, created: 134058000000000000, name: "cmd.exe" },
      { pid: 12, ppid: 1, name: "/Applications/Some App.app/Contents/MacOS/Some App" },
      { pid: 13, ppid: 1 },
    ]);
  });
});

describe("descendants", () => {
  it("找得到真實的子程序，子程序結束後就不在其中，也不再算還在執行", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    const pid = child.pid as number;
    let tree: ReturnType<typeof processTree>;
    try {
      expect(descendants(process.pid)).toContain(pid);
      tree = processTree(process.pid);
      expect(tree.map((entry) => entry.pid)).toEqual(expect.arrayContaining([process.pid, pid]));
      expect(aliveProcesses(tree).map((entry) => entry.pid)).toContain(pid);
      expect(tree.find((entry) => entry.pid === pid)?.name).toMatch(/node/);
    } finally {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    expect(descendants(process.pid)).not.toContain(pid);
    expect(aliveProcesses(tree).map((entry) => entry.pid)).not.toContain(pid);
    expect(aliveProcesses(tree).map((entry) => entry.pid)).toContain(process.pid);
  });
});
