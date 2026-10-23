// 組出「用編輯器開啟」與「在終端機開啟」要執行的指令。純函式，三平台都可以在任一平台上測試。
// - 參數以陣列傳給 spawn，不經過 shell。
// - 執行檔一律是絕對路徑：Windows 上以裸名稱 spawn 時會先搜尋 cwd，而 Worktree 的內容可能是 Agent
//   寫的，不能讓它放一個同名的執行檔被我們執行。
// - Windows 上 npm 類的 CLI 是 `.cmd` shim，Node 不允許直接 spawn，要經由 `cmd.exe /d /s /c`，
//   這時整行指令由我們自己加引號（windowsVerbatimArguments）。

import { posix, win32 } from "node:path";
import { CUSTOM_PRESET, PATH_PLACEHOLDER, type ToolChoice } from "./presets";

export interface LaunchSpec {
  /** 絕對路徑。 */
  command: string;
  args: string[];
  cwd?: string;
  /** 加到子程序環境變數中的值。 */
  env?: Record<string, string>;
  /** Windows：args 已經自行加好引號，不要讓 Node 再處理。 */
  windowsVerbatimArguments?: boolean;
  /** 不要顯示主控台視窗（GUI 程式經由 cmd.exe 啟動時使用）。 */
  windowsHide: boolean;
}

export type LaunchResult = { ok: true; spec: LaunchSpec } | { ok: false; message: string };

export interface CommandEnv {
  platform: NodeJS.Platform;
  /** 在 PATH 中找執行檔，Windows 上依 PATHEXT 補副檔名；找不到時回傳 null。回傳值一定是絕對路徑。 */
  which: (name: string) => string | null;
  /** 檔案是否存在（Windows 的 App execution alias 也算）。 */
  exists: (path: string) => boolean;
  env: NodeJS.ProcessEnv;
}

/**
 * Windows：讓 cmd.exe 與 CreateProcess 不在目前目錄中找執行檔。`.cmd` shim 內部呼叫的指令
 * 也因此不會解析到 Worktree 裡的檔案。
 */
const WINDOWS_SAFE_ENV = { NoDefaultCurrentDirectoryInExePath: "1" };

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

/** Windows 系統目錄（`%SystemRoot%`），取不到絕對路徑時用預設值。 */
function systemRoot(env: CommandEnv): string {
  const root = env.env.SystemRoot ?? env.env.windir;
  return root && win32.isAbsolute(root) ? root : "C:\\Windows";
}

function cmdExe(env: CommandEnv): string {
  const comSpec = env.env.ComSpec;
  return comSpec && win32.isAbsolute(comSpec)
    ? comSpec
    : win32.join(systemRoot(env), "System32", "cmd.exe");
}

/** cmd.exe 的引號：整個參數包在雙引號內。含有 `"`、`%`、換行的參數無法安全傳遞，直接拒絕。 */
function quoteForCmd(arg: string): string | null {
  if (/["%\r\n]/.test(arg)) return null;
  return `"${arg}"`;
}

/** Windows 的 `.cmd`／`.bat` 要經由 cmd.exe 執行；其他平台與一般執行檔原樣回傳。 */
export function wrapWindowsShim(spec: LaunchSpec, env: CommandEnv): LaunchResult {
  if (env.platform !== "win32") return { ok: true, spec };
  const safe = { ...spec, env: { ...spec.env, ...WINDOWS_SAFE_ENV } };
  if (!/\.(cmd|bat)$/i.test(spec.command)) return { ok: true, spec: safe };
  const quoted = [spec.command, ...spec.args].map(quoteForCmd);
  if (quoted.some((q) => q === null)) {
    return { ok: false, message: '路徑或指令含有 cmd.exe 無法安全處理的字元（"、% 或換行）' };
  }
  return {
    ok: true,
    spec: {
      ...safe,
      command: cmdExe(env),
      // /s 讓 cmd 只去掉最外層的一對引號，內層每個參數各自的引號保留
      args: ["/d", "/s", "/c", `"${quoted.join(" ")}"`],
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

/** 在 PATH 中找到執行檔後組成 LaunchSpec。 */
function fromPath(
  name: string,
  args: string[],
  env: CommandEnv,
  options: { cwd?: string; windowsHide: boolean },
): LaunchResult {
  const resolved = env.which(name);
  if (!resolved) return notFound(name);
  return wrapWindowsShim({ command: resolved, args, ...options }, env);
}

function custom(template: string, path: string, env: CommandEnv): LaunchResult {
  const tokens = parseCommandTemplate(template);
  const [program, ...rest] = tokens;
  if (!program) return { ok: false, message: "自訂指令是空的，請到設定中填寫" };
  const args = rest.map((t) => t.replaceAll(PATH_PLACEHOLDER, path));
  if (!tokens.some((t) => t.includes(PATH_PLACEHOLDER))) args.push(path);
  const lib = env.platform === "win32" ? win32 : posix;
  const options = { cwd: path, windowsHide: false };
  if (lib.isAbsolute(program)) {
    if (!env.exists(program)) return notFound(program);
    return wrapWindowsShim({ command: program, args, ...options }, env);
  }
  // 只接受 PATH 中的程式；`./x`、`..\x` 這類相對路徑會指到 Worktree 裡
  if (program.includes("/") || program.includes("\\")) {
    return { ok: false, message: "自訂指令的程式請用絕對路徑或 PATH 中的名稱" };
  }
  return fromPath(program, args, env, options);
}

export function buildEditorLaunch(choice: ToolChoice, path: string, env: CommandEnv): LaunchResult {
  if (choice.preset === CUSTOM_PRESET.id) return custom(choice.customCommand, path, env);
  if (env.platform === "darwin") {
    // macOS 上 VS Code 的 `code` CLI 要另外安裝，用 open 以 bundle 開啟比較可靠
    const app = choice.preset === "cursor" ? ["-a", "Cursor"] : ["-b", "com.microsoft.VSCode"];
    return {
      ok: true,
      spec: { command: "/usr/bin/open", args: [...app, path], windowsHide: true },
    };
  }
  const cli = choice.preset === "cursor" ? "cursor" : "code";
  // 編輯器不需要 cwd，用 Desktop 自己的工作目錄
  return fromPath(cli, [path], env, { windowsHide: true });
}

function gitBash(env: CommandEnv): string | null {
  const git = env.which("git");
  const candidates = [
    // <Git>\cmd\git.exe → <Git>\git-bash.exe
    git ? win32.join(win32.dirname(win32.dirname(git)), "git-bash.exe") : null,
    env.env.ProgramFiles && win32.isAbsolute(env.env.ProgramFiles)
      ? win32.join(env.env.ProgramFiles, "Git", "git-bash.exe")
      : null,
  ];
  return candidates.find((c): c is string => c !== null && env.exists(c)) ?? null;
}

/** Windows Terminal 是 App execution alias，通常在 `%LOCALAPPDATA%\Microsoft\WindowsApps`。 */
function windowsTerminal(env: CommandEnv): string | null {
  const local = env.env.LOCALAPPDATA;
  const alias =
    local && win32.isAbsolute(local)
      ? win32.join(local, "Microsoft", "WindowsApps", "wt.exe")
      : null;
  return env.which("wt") ?? (alias && env.exists(alias) ? alias : null);
}

export function buildTerminalLaunch(
  choice: ToolChoice,
  path: string,
  env: CommandEnv,
): LaunchResult {
  if (choice.preset === CUSTOM_PRESET.id) return custom(choice.customCommand, path, env);
  const visible = (command: string, args: string[]): LaunchResult =>
    wrapWindowsShim({ command, args, cwd: path, windowsHide: false }, env);
  switch (env.platform) {
    case "win32":
      switch (choice.preset) {
        case "windows-terminal": {
          const wt = windowsTerminal(env);
          // 目錄經由 cwd 傳遞，不放進 wt 的命令列：wt 會把參數中的 `;` 當成子命令的分隔
          return wt ? visible(wt, ["-d", "."]) : notFound("Windows Terminal");
        }
        case "powershell":
          return visible(
            win32.join(systemRoot(env), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            ["-NoExit"],
          );
        case "cmd":
          return visible(cmdExe(env), ["/k"]);
        case "git-bash": {
          const bash = gitBash(env);
          return bash ? visible(bash, [`--cd=${path}`]) : notFound("Git Bash");
        }
      }
      break;
    case "darwin": {
      const app = choice.preset === "iterm" ? "iTerm" : "Terminal";
      return visible("/usr/bin/open", ["-a", app, path]);
    }
    default: {
      const options = { cwd: path, windowsHide: false };
      switch (choice.preset) {
        case "gnome-terminal":
          return fromPath("gnome-terminal", [`--working-directory=${path}`], env, options);
        case "konsole":
          return fromPath("konsole", ["--workdir", path], env, options);
        case "x-terminal-emulator":
          return fromPath("x-terminal-emulator", [], env, options);
      }
    }
  }
  return { ok: false, message: `不支援的終端機設定：${choice.preset}` };
}

/** 依 PATH（與 Windows 的 PATHEXT）找執行檔。PATH 中的相對路徑一律略過。 */
export function createWhich(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isFile: (path: string) => boolean,
): (name: string) => string | null {
  const lib = platform === "win32" ? win32 : posix;
  const pathVar = (platform === "win32" ? (env.Path ?? env.PATH) : env.PATH) ?? "";
  const dirs = pathVar
    .split(platform === "win32" ? ";" : ":")
    .map((dir) => dir.replace(/^"|"$/g, ""))
    .filter((dir) => dir !== "" && lib.isAbsolute(dir));
  const exts =
    platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  return (name) => {
    const hasExt = platform === "win32" && /\.[^\\/.]+$/.test(name);
    for (const dir of dirs) {
      for (const ext of hasExt ? [""] : exts) {
        const candidate = lib.join(dir, `${name}${ext.toLowerCase()}`);
        if (isFile(candidate)) return candidate;
      }
    }
    return null;
  };
}
