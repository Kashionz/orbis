// 組出「用編輯器開啟」與「在終端機開啟」要執行的指令。純函式，三平台都可以在任一平台上測試。
// - 參數以陣列傳給 spawn，不經過 shell。
// - Windows 上 npm 類的 CLI 是 `.cmd` shim，Node 不允許直接 spawn，要經由 `cmd.exe /d /s /c`，
//   這時整行指令由我們自己加引號（windowsVerbatimArguments）。

import { posix, win32 } from "node:path";
import { CUSTOM_PRESET, PATH_PLACEHOLDER, type ToolChoice } from "./presets";

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  /** Windows：args 已經自行加好引號，不要讓 Node 再處理。 */
  windowsVerbatimArguments?: boolean;
  /** 不要顯示主控台視窗（GUI 程式經由 cmd.exe 啟動時使用）。 */
  windowsHide: boolean;
}

export type LaunchResult = { ok: true; spec: LaunchSpec } | { ok: false; message: string };

export interface CommandEnv {
  platform: NodeJS.Platform;
  /** 在 PATH 中找執行檔，Windows 上依 PATHEXT 補副檔名；找不到時回傳 null。 */
  which: (name: string) => string | null;
  /** 檔案是否存在。 */
  exists: (path: string) => boolean;
  env: NodeJS.ProcessEnv;
}

/** 把 `{path}` 樣板拆成 argv。支援雙引號包住含空白的參數；反斜線照原樣保留（Windows 路徑）。 */
export function parseCommandTemplate(template: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let hasToken = false;
  for (const char of template) {
    if (char === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
    } else if (/\s/.test(char) && !inQuotes) {
      if (hasToken) tokens.push(current);
      current = "";
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/** cmd.exe 的引號：整個參數包在雙引號內。含有 `"`、`%`、換行的參數無法安全傳遞，直接拒絕。 */
function quoteForCmd(arg: string): string | null {
  if (/["%\r\n]/.test(arg)) return null;
  return `"${arg}"`;
}

/** Windows 的 `.cmd`／`.bat` 要經由 cmd.exe 執行。 */
export function wrapWindowsShim(spec: LaunchSpec, env: CommandEnv): LaunchResult {
  if (env.platform !== "win32" || !/\.(cmd|bat)$/i.test(spec.command)) return { ok: true, spec };
  const quoted = [spec.command, ...spec.args].map(quoteForCmd);
  if (quoted.some((q) => q === null)) {
    return { ok: false, message: '路徑或指令含有 cmd.exe 無法安全處理的字元（"、% 或換行）' };
  }
  return {
    ok: true,
    spec: {
      command: env.env.ComSpec ?? "cmd.exe",
      // /s 讓 cmd 只去掉最外層的一對引號，內層每個參數各自的引號保留
      args: ["/d", "/s", "/c", `"${quoted.join(" ")}"`],
      cwd: spec.cwd,
      windowsVerbatimArguments: true,
      windowsHide: true,
    },
  };
}

function notFound(name: string): LaunchResult {
  return {
    ok: false,
    message: `找不到 ${name}，請確認已經安裝並加入 PATH，或在設定中改用自訂指令`,
  };
}

/** 在 PATH 中找到執行檔後組成 LaunchSpec，Windows 的 shim 會經由 cmd.exe。 */
function fromPath(
  name: string,
  args: string[],
  cwd: string,
  env: CommandEnv,
  windowsHide = true,
): LaunchResult {
  const resolved = env.which(name);
  if (!resolved) return notFound(name);
  return wrapWindowsShim({ command: resolved, args, cwd, windowsHide }, env);
}

function custom(template: string, path: string, env: CommandEnv): LaunchResult {
  const tokens = parseCommandTemplate(template);
  const [program, ...rest] = tokens;
  if (!program) return { ok: false, message: "自訂指令是空的，請到設定中填寫" };
  const args = rest.map((t) => t.replaceAll(PATH_PLACEHOLDER, path));
  if (!tokens.some((t) => t.includes(PATH_PLACEHOLDER))) args.push(path);
  const lib = env.platform === "win32" ? win32 : posix;
  if (lib.isAbsolute(program)) {
    if (!env.exists(program)) return notFound(program);
    return wrapWindowsShim({ command: program, args, cwd: path, windowsHide: false }, env);
  }
  return fromPath(program, args, path, env, false);
}

export function buildEditorLaunch(choice: ToolChoice, path: string, env: CommandEnv): LaunchResult {
  if (choice.preset === CUSTOM_PRESET.id) return custom(choice.customCommand, path, env);
  if (env.platform === "darwin") {
    // macOS 上 VS Code 的 `code` CLI 要另外安裝，用 open 以 bundle 開啟比較可靠
    const app = choice.preset === "cursor" ? ["-a", "Cursor"] : ["-b", "com.microsoft.VSCode"];
    return { ok: true, spec: { command: "open", args: [...app, path], windowsHide: true } };
  }
  const cli = choice.preset === "cursor" ? "cursor" : "code";
  return fromPath(cli, [path], path, env);
}

function gitBash(env: CommandEnv): string | null {
  const git = env.which("git");
  const candidates = [
    // <Git>\cmd\git.exe → <Git>\git-bash.exe
    git ? win32.join(win32.dirname(win32.dirname(git)), "git-bash.exe") : null,
    env.env.ProgramFiles ? win32.join(env.env.ProgramFiles, "Git", "git-bash.exe") : null,
  ];
  return candidates.find((c): c is string => c !== null && env.exists(c)) ?? null;
}

export function buildTerminalLaunch(
  choice: ToolChoice,
  path: string,
  env: CommandEnv,
): LaunchResult {
  if (choice.preset === CUSTOM_PRESET.id) return custom(choice.customCommand, path, env);
  const visible = (command: string, args: string[]): LaunchResult => ({
    ok: true,
    spec: { command, args, cwd: path, windowsHide: false },
  });
  switch (env.platform) {
    case "win32":
      switch (choice.preset) {
        case "windows-terminal":
          // wt.exe 是 App execution alias，交給 CreateProcess 在 PATH 中找
          return visible("wt.exe", ["-d", path]);
        case "powershell":
          return visible("powershell.exe", ["-NoExit"]);
        case "cmd":
          return visible(env.env.ComSpec ?? "cmd.exe", ["/k"]);
        case "git-bash": {
          const bash = gitBash(env);
          return bash ? visible(bash, [`--cd=${path}`]) : notFound("Git Bash");
        }
      }
      break;
    case "darwin": {
      const app = choice.preset === "iterm" ? "iTerm" : "Terminal";
      return visible("open", ["-a", app, path]);
    }
    default:
      switch (choice.preset) {
        case "gnome-terminal":
          return fromPath("gnome-terminal", [`--working-directory=${path}`], path, env, false);
        case "konsole":
          return fromPath("konsole", ["--workdir", path], path, env, false);
        case "x-terminal-emulator":
          return fromPath("x-terminal-emulator", [], path, env, false);
      }
  }
  return { ok: false, message: `不支援的終端機設定：${choice.preset}` };
}

/** 依 PATH（與 Windows 的 PATHEXT）找執行檔。 */
export function createWhich(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isFile: (path: string) => boolean,
): (name: string) => string | null {
  const lib = platform === "win32" ? win32 : posix;
  const pathVar = (platform === "win32" ? (env.Path ?? env.PATH) : env.PATH) ?? "";
  const dirs = pathVar.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const exts =
    platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  return (name) => {
    const hasExt = platform === "win32" && /\.[^\\/.]+$/.test(name);
    for (const dir of dirs) {
      for (const ext of hasExt ? [""] : exts) {
        const candidate = lib.join(dir.replace(/^"|"$/g, ""), `${name}${ext.toLowerCase()}`);
        if (isFile(candidate)) return candidate;
      }
    }
    return null;
  };
}
