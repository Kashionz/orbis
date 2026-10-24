// 列出某個程序的子孫程序，給完整系統 e2e 在結束時確認沒有殘留的程序。
//
// Windows 的 ParentProcessId 在父程序結束後不會更新，PID 又會很快被重用：一個父程序早已結束的
// 長壽程序（例如 CI 上 pg_ctl 以 cmd.exe 啟動的 Postgres 與它的子程序），在它的舊父 PID
// 被我們啟動的程序拿到時，只看 ParentProcessId 就會被當成我們的子孫。所以 Windows 上另外比較
// 建立時間：子程序不可能比父程序早建立，比「父程序」早建立的就不是它的子程序。
// macOS／Linux 的 ppid 在父程序結束時會改成 init（或 subreaper），不會有這個問題。

import { execFileSync } from "node:child_process";

/** 程序表的一列。`created` 是建立時間（可比較大小的數字；不知道時省略）。 */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  created?: number;
  /** 程序名稱（殘留時列在錯誤訊息中）。 */
  name?: string;
}

/** 從程序表找出 rootPid 的所有子孫程序（廣度優先）。 */
export function descendantsIn(table: readonly ProcessEntry[], rootPid: number): number[] {
  const created = new Map(table.map((entry) => [entry.pid, entry.created]));
  const children = new Map<number, number[]>();
  for (const entry of table) {
    const parentCreated = created.get(entry.ppid);
    // 比父 PID 目前的程序還早建立：舊父程序已經結束、PID 被重用，不是它的子程序
    if (
      entry.created !== undefined &&
      parentCreated !== undefined &&
      entry.created < parentCreated
    ) {
      continue;
    }
    children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry.pid]);
  }
  const found: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift() as number) ?? []) {
      // 防止程序表中的循環（PID 重用時可能出現）
      if (child === rootPid || found.includes(child)) continue;
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** 目前的程序表。Windows 帶建立時間（FILETIME，100 奈秒為單位）。 */
export function processTable(): ProcessEntry[] {
  const raw =
    process.platform === "win32"
      ? execFileSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() })`t$($_.Name)" }',
          ],
          { encoding: "utf8", windowsHide: true },
        )
      : // comm 放最後（名稱中可能有空白），沒有建立時間，轉成同樣的 tab 分隔格式
        execFileSync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8" }).replace(
          /^[ \t]*(\d+)[ \t]+(\d+)[ \t]*/gm,
          "$1\t$2\t\t",
        );
  return parseProcessTable(raw);
}

/** 解析 {@link processTable} 的輸出：每列是 `pid<tab>ppid<tab>建立時間<tab>名稱`，後兩欄可以是空的。 */
export function parseProcessTable(raw: string): ProcessEntry[] {
  const table: ProcessEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const [pidField = "", ppidField = "", createdField = "", ...nameFields] = line.split("\t");
    const pid = Number(pidField.trim());
    const ppid = Number(ppidField.trim());
    if (!pid || !ppidField.trim() || !Number.isInteger(ppid)) continue;
    const entry: ProcessEntry = { pid, ppid };
    if (createdField.trim()) {
      const created = Number(createdField);
      if (!Number.isNaN(created)) entry.created = created;
    }
    const name = nameFields.join("\t").trim();
    if (name) entry.name = name;
    table.push(entry);
  }
  return table;
}

/** 某個程序目前所有的子孫程序。 */
export function descendants(rootPid: number): number[] {
  return descendantsIn(processTable(), rootPid);
}

/** 根程序與它目前的子孫程序（含建立時間，之後用 {@link aliveProcesses} 確認是否還在）。 */
export function processTree(rootPid: number): ProcessEntry[] {
  const table = processTable();
  const pids = new Set([rootPid, ...descendantsIn(table, rootPid)]);
  return table.filter((entry) => pids.has(entry.pid));
}

/**
 * 記下的程序中還在執行的程序。有建立時間時要 PID 與建立時間都相同才算同一個程序：
 * 記下的程序結束後 PID 可能已經被無關的程序重用。
 */
export function aliveIn(
  table: readonly ProcessEntry[],
  recorded: readonly ProcessEntry[],
): ProcessEntry[] {
  return recorded.filter((entry) =>
    table.some(
      (current) =>
        current.pid === entry.pid &&
        (entry.created === undefined || current.created === entry.created),
    ),
  );
}

/** 記下的程序中目前還在執行的程序。 */
export function aliveProcesses(recorded: readonly ProcessEntry[]): ProcessEntry[] {
  return recorded.length === 0 ? [] : aliveIn(processTable(), recorded);
}
