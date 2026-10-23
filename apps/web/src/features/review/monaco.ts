// Monaco 的設定：只載入編輯器核心與語法上色（不載入語言服務），worker 由 Vite 打包，
// 不從 CDN 載入。

import "monaco-editor/basic-languages/monaco.contribution";
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
  }
}

window.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export { monaco };

const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  rs: "rust",
  py: "python",
  go: "go",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  sh: "shell",
  ps1: "powershell",
  sql: "sql",
};

/** 依副檔名決定 Monaco 的語言；不認得的用純文字。 */
export function languageOf(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGES[extension] ?? "plaintext";
}
