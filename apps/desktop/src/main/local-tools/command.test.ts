import { NAMES } from "@orbis/api-contract/names";
import { describe, expect, it } from "vitest";
import {
  buildEditorLaunch,
  buildTerminalLaunch,
  type CommandEnv,
  createWhich,
  parseCommandTemplate,
} from "./command";

const WT = `${NAMES.worktreeRootWindows}\\my repo\\ORB-12-1`;
const SAFE_ENV = { NoDefaultCurrentDirectoryInExePath: "1" };

function windowsEnv(files: string[], extra: Record<string, string> = {}): CommandEnv {
  const set = new Set(files.map((f) => f.toLowerCase()));
  const isFile = (p: string) => set.has(p.toLowerCase());
  const env = {
    Path: "C:\\Windows\\System32;.;relative\\bin;C:\\Program Files\\Microsoft VS Code\\bin;C:\\Program Files\\Git\\cmd",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    ...extra,
  };
  return { platform: "win32", which: createWhich("win32", env, isFile), exists: isFile, env };
}

function posixEnv(platform: NodeJS.Platform, files: string[]): CommandEnv {
  const set = new Set(files);
  const isFile = (p: string) => set.has(p);
  const env = { PATH: "/usr/local/bin:.:bin:/usr/bin" };
  return { platform, which: createWhich(platform, env, isFile), exists: isFile, env };
}

describe("parseCommandTemplate", () => {
  it("以空白分隔，雙引號包住含空白的參數，反斜線照原樣保留", () => {
    expect(parseCommandTemplate('"C:\\Program Files\\Sub\\sub.exe" -n {path}')).toEqual([
      "C:\\Program Files\\Sub\\sub.exe",
      "-n",
      "{path}",
    ]);
    expect(parseCommandTemplate("  alacritty   --working-directory={path} ")).toEqual([
      "alacritty",
      "--working-directory={path}",
    ]);
    expect(parseCommandTemplate('vim ""')).toEqual(["vim", ""]);
  });
});

describe("createWhich", () => {
  it("略過 PATH 中的相對路徑（例如 .），避免找到目前目錄裡的檔案", () => {
    const which = createWhich("win32", { Path: ".;tools;C:\\bin", PATHEXT: ".EXE" }, (p) =>
      ["code.exe", "tools\\code.exe", "C:\\bin\\code.exe"].includes(p),
    );
    expect(which("code")).toBe("C:\\bin\\code.exe");
    const posixWhich = createWhich("linux", { PATH: ".:/usr/bin" }, (p) =>
      ["code", "/usr/bin/code"].includes(p),
    );
    expect(posixWhich("code")).toBe("/usr/bin/code");
  });
});

describe("buildEditorLaunch（Windows）", () => {
  it("VS Code 的 code.cmd 經由 cmd.exe，路徑含空白時自己加引號，不使用 Worktree 當 cwd", () => {
    const env = windowsEnv(["C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd"]);
    expect(buildEditorLaunch({ preset: "vscode", customCommand: "" }, WT, env)).toEqual({
      ok: true,
      spec: {
        command: "C:\\Windows\\system32\\cmd.exe",
        args: ["/d", "/s", "/c", `""C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd" "${WT}""`],
        env: SAFE_ENV,
        windowsVerbatimArguments: true,
        windowsHide: true,
      },
    });
  });

  it("ComSpec 不是絕對路徑時改用 System32 的 cmd.exe", () => {
    const env = windowsEnv(["C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd"], {
      ComSpec: "cmd.exe",
    });
    const result = buildEditorLaunch({ preset: "vscode", customCommand: "" }, WT, env);
    expect(result).toMatchObject({ ok: true, spec: { command: "C:\\Windows\\System32\\cmd.exe" } });
  });

  it("找不到 CLI 時回傳可以照著做的訊息", () => {
    const result = buildEditorLaunch({ preset: "cursor", customCommand: "" }, WT, windowsEnv([]));
    expect(result).toEqual({
      ok: false,
      message: "找不到 cursor，請確認已經安裝並加入 PATH，或在設定中改用自訂指令",
    });
  });

  it("含 % 的路徑無法安全交給 cmd.exe，直接拒絕", () => {
    const env = windowsEnv(["C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd"]);
    const result = buildEditorLaunch(
      { preset: "vscode", customCommand: "" },
      `${NAMES.worktreeRootWindows}\\a\\%PATH%`,
      env,
    );
    expect(result.ok).toBe(false);
  });

  it("自訂指令：絕對路徑的 .exe 直接 spawn，{path} 換成 Worktree", () => {
    const exe = "C:\\Program Files\\Sublime Text\\subl.exe";
    const env = windowsEnv([exe]);
    expect(
      buildEditorLaunch(
        { preset: "custom", customCommand: `"${exe}" --new-window {path}` },
        WT,
        env,
      ),
    ).toEqual({
      ok: true,
      spec: {
        command: exe,
        args: ["--new-window", WT],
        cwd: WT,
        env: SAFE_ENV,
        windowsHide: false,
      },
    });
  });

  it("自訂指令沒有 {path} 時把路徑附在最後；PATH 中的名稱解析成絕對路徑", () => {
    const env = windowsEnv(["C:\\Windows\\System32\\notepad.exe"]);
    const result = buildEditorLaunch({ preset: "custom", customCommand: "notepad" }, WT, env);
    expect(result).toMatchObject({
      ok: true,
      spec: { command: "C:\\Windows\\System32\\notepad.exe", args: [WT] },
    });
  });

  it("自訂指令不接受相對路徑的程式（會指到 Worktree 裡的檔案）", () => {
    const env = windowsEnv([`${WT}\\evil.exe`]);
    for (const program of [".\\evil.exe", "tools/evil", "..\\evil.exe"]) {
      expect(
        buildEditorLaunch({ preset: "custom", customCommand: `${program} {path}` }, WT, env),
      ).toEqual({ ok: false, message: "自訂指令的程式請用絕對路徑或 PATH 中的名稱" });
    }
  });
});

describe("buildTerminalLaunch（Windows）", () => {
  const wtAlias = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
  const env = windowsEnv([
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\git-bash.exe",
    wtAlias,
  ]);

  it("Windows Terminal 以絕對路徑啟動，目錄經由 cwd 傳遞（不放進 wt 的命令列）", () => {
    const withSemicolon = `${NAMES.worktreeRootWindows}\\repo\\a; new-tab calc`;
    expect(
      buildTerminalLaunch({ preset: "windows-terminal", customCommand: "" }, withSemicolon, env),
    ).toEqual({
      ok: true,
      spec: {
        command: wtAlias,
        args: ["-d", "."],
        cwd: withSemicolon,
        env: SAFE_ENV,
        windowsHide: false,
      },
    });
    expect(
      buildTerminalLaunch({ preset: "windows-terminal", customCommand: "" }, WT, windowsEnv([])),
    ).toMatchObject({ ok: false });
  });

  it("PowerShell 與 cmd 用 System32 的絕對路徑，以 cwd 指定目錄並顯示視窗", () => {
    expect(buildTerminalLaunch({ preset: "powershell", customCommand: "" }, WT, env)).toEqual({
      ok: true,
      spec: {
        command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        args: ["-NoExit"],
        cwd: WT,
        env: SAFE_ENV,
        windowsHide: false,
      },
    });
    expect(buildTerminalLaunch({ preset: "cmd", customCommand: "" }, WT, env)).toMatchObject({
      ok: true,
      spec: { command: "C:\\Windows\\system32\\cmd.exe", args: ["/k"], cwd: WT },
    });
  });

  it("Git Bash 從 git.exe 的位置找到 git-bash.exe", () => {
    expect(buildTerminalLaunch({ preset: "git-bash", customCommand: "" }, WT, env)).toEqual({
      ok: true,
      spec: {
        command: "C:\\Program Files\\Git\\git-bash.exe",
        args: [`--cd=${WT}`],
        cwd: WT,
        env: SAFE_ENV,
        windowsHide: false,
      },
    });
    expect(
      buildTerminalLaunch({ preset: "git-bash", customCommand: "" }, WT, windowsEnv([])).ok,
    ).toBe(false);
  });
});

describe("macOS 與 Linux", () => {
  const path = "/Users/me/.wt/my repo/ORB-12-1";

  it("macOS 用 /usr/bin/open 開啟編輯器與終端機", () => {
    const env = posixEnv("darwin", []);
    expect(buildEditorLaunch({ preset: "vscode", customCommand: "" }, path, env)).toEqual({
      ok: true,
      spec: {
        command: "/usr/bin/open",
        args: ["-b", "com.microsoft.VSCode", path],
        windowsHide: true,
      },
    });
    expect(buildTerminalLaunch({ preset: "iterm", customCommand: "" }, path, env)).toMatchObject({
      ok: true,
      spec: { command: "/usr/bin/open", args: ["-a", "iTerm", path] },
    });
  });

  it("Linux 在 PATH 中找編輯器與終端機", () => {
    const env = posixEnv("linux", ["/usr/bin/code", "/usr/bin/gnome-terminal"]);
    expect(buildEditorLaunch({ preset: "vscode", customCommand: "" }, path, env)).toEqual({
      ok: true,
      spec: { command: "/usr/bin/code", args: [path], windowsHide: true },
    });
    expect(
      buildTerminalLaunch({ preset: "gnome-terminal", customCommand: "" }, path, env),
    ).toMatchObject({
      ok: true,
      spec: { command: "/usr/bin/gnome-terminal", args: [`--working-directory=${path}`] },
    });
    expect(buildTerminalLaunch({ preset: "konsole", customCommand: "" }, path, env).ok).toBe(false);
  });

  it("自訂指令是空的時提示到設定中填寫", () => {
    expect(
      buildTerminalLaunch({ preset: "custom", customCommand: "  " }, path, posixEnv("linux", [])),
    ).toEqual({ ok: false, message: "自訂指令是空的，請到設定中填寫" });
  });
});
