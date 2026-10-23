// CI log 的摘要（ARCHITECTURE §5.2）：只擷取失敗的段落，不放完整的 log。
//
// GitHub Actions 的 job log 每行開頭是時間戳記；每個步驟以 `##[group]Run <指令>` 開始，
// 指令內容到 `##[endgroup]` 為止，之後是步驟的輸出；失敗處有 `##[error]`。

/** 每個失敗步驟最多保留的輸出行數（取錯誤之前的最後幾行）。 */
export const FAILURE_EXCERPT_LINES = 60;
/** 一個 check 的摘要最多幾個字元。 */
export const FAILURE_EXCERPT_MAX_CHARS = 6000;

const TIMESTAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 要去掉的正是 ANSI 控制碼
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** 去掉時間戳記與 ANSI 色碼。 */
function clean(line: string): string {
  return line.replace(TIMESTAMP, "").replace(ANSI, "").replace(/\r$/, "");
}

interface Step {
  /** `Run` 之後的指令第一行，或 group 的名稱。 */
  name: string;
  /** 步驟的輸出（group 標頭之後）。 */
  output: string[];
}

function splitSteps(lines: readonly string[]): Step[] {
  const steps: Step[] = [{ name: "", output: [] }];
  let inHeader = false;
  for (const raw of lines) {
    const line = clean(raw);
    const group = /^##\[group\](.*)$/.exec(line);
    if (group) {
      steps.push({ name: (group[1] ?? "").replace(/^Run /, "").trim(), output: [] });
      inHeader = true;
      continue;
    }
    if (line.startsWith("##[endgroup]")) {
      inHeader = false;
      continue;
    }
    if (inHeader) continue;
    steps[steps.length - 1]?.output.push(line);
  }
  return steps;
}

export interface FailureExcerpt {
  /** 失敗的步驟名稱；找不到 `##[error]` 時為 null。 */
  step: string | null;
  /** 擷取的輸出，已去掉時間戳記與色碼。 */
  lines: string[];
  /** 是否截掉了前面的輸出。 */
  truncated: boolean;
}

/**
 * 從 job log 擷取失敗的段落：第一個含 `##[error]` 的步驟中、錯誤之前的最後幾行（含錯誤本身）。
 * 沒有 `##[error]` 時取整份 log 的最後幾行。
 */
export function extractFailureExcerpt(log: string): FailureExcerpt {
  const steps = splitSteps(log.split("\n"));
  for (const step of steps) {
    const errorIndex = step.output.findIndex((l) => l.startsWith("##[error]"));
    if (errorIndex < 0) continue;
    const upTo = step.output.slice(0, errorIndex + 1);
    const start = Math.max(0, upTo.length - FAILURE_EXCERPT_LINES);
    return {
      step: step.name || null,
      lines: upTo.slice(start).map((l) => l.replace(/^##\[error\]/, "Error: ")),
      truncated: start > 0,
    };
  }
  const all = steps.flatMap((s) => s.output).filter((l) => l.trim() !== "");
  const start = Math.max(0, all.length - FAILURE_EXCERPT_LINES);
  return { step: null, lines: all.slice(start), truncated: start > 0 };
}

/** 限制字元數：保留後面（錯誤在最後）。 */
export function limitTail(text: string, max = FAILURE_EXCERPT_MAX_CHARS): string {
  return text.length <= max ? text : `…（前面省略）\n${text.slice(text.length - max)}`;
}
