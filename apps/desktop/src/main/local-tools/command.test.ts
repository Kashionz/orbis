import { NAMES } from "@orbis/api-contract/names";
import { describe, expect, it } from "vitest";
import {
  buildEditorLaunch,
  buildTerminalLaunch,
  type CommandEnv,
  createWhich,
  parseCommandTemplate,
} from "./command";

const WT = `${NAMES.worktreeRootWindows}\\my repo\\ORB-12`;

function windowsEnv(files: string[]): CommandEnv {
  const set = new Set(files.map((f) => f.toLowerCase()));
  const isFile = (p: string) => set.has(p.toLowerCase());
  const env = {
    Path: "C:\\Windows\\System32;C:\\Program Files\\Microsoft VS Code\\bin;C:\\Program Files\\Git\\cmd",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
    ProgramFiles: "C:\\Program Files",
  };
  return { platform: "win32", which: createWhich("win32", env, isFile), exists: isFile, env };
}

function posixEnv(platform: NodeJS.Platform, files: string[]): CommandEnv {
  const set = new Set(files);
  const isFile = (p: string) => set.has(p);
  const env = { PATH: "/usr/local/bin:/usr/bin" };
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

describe("buildEditorLaunch（Windows）", () => {
  it("VS Code 的 code.cmd 經由 cmd.exe，路徑含空白時自己加引號", () => {
    const env = windowsEnv(["C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd"]);
    expect(buildEditorLaunch({ preset: "vscode", customCommand: "" }, WT, env)).toEqual({
      ok: true,
      spec: {
        command: "C:\\Windows\\system32\\cmd.exe",
        args: ["/d", "/s", "/c", `""C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd" "${WT}""`],
        cwd: WT,
        windowsVerbatimArguments: true,
        windowsHide: true,
      },
    });
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
      `${NAMES.worktreeRootWindows}\\a%PATH%`,
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
      spec: { command: exe, args: ["--new-window", WT], cwd: WT, windowsHide: false },
    });
  });

  it("自訂指令沒有 {path} 時把路徑附在最後", () => {
    const env = windowsEnv(["C:\\Windows\\System32\\notepad.exe"]);
    const result = buildEditorLaunch({ preset: "custom", customCommand: "notepad" }, WT, env);
    expect(result).toMatchObject({ ok: true, spec: { args: [WT] } });
  });
});

describe("buildTerminalLaunch（Windows）", () => {
  const env = windowsEnv([
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\git-bash.exe",
  ]);

  it("Windows Terminal 用 -d 指定目錄", () => {
    expect(buildTerminalLaunch({ preset: "windows-terminal", customCommand: "" }, WT, env)).toEqual(
      {
        ok: true,
        spec: { command: "wt.exe", args: ["-d", WT], cwd: WT, windowsHide: false },
      },
    );
  });

  it("PowerShell 與 cmd 以 cwd 指定目錄並顯示視窗", () => {
    expect(buildTerminalLaunch({ preset: "powershell", customCommand: "" }, WT, env)).toMatchObject(
      {
        ok: true,
        spec: { command: "powershell.exe", args: ["-NoExit"], cwd: WT, windowsHide: false },
      },
    );
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
        windowsHide: false,
      },
    });
    expect(
      buildTerminalLaunch({ preset: "git-bash", customCommand: "" }, WT, windowsEnv([])).ok,
    ).toBe(false);
  });
});

describe("macOS 與 Linux", () => {
  const path = "/Users/me/.wt/my repo/ORB-12";

  it("macOS 用 open 開啟編輯器與終端機", () => {
    const env = posixEnv("darwin", []);
    expect(buildEditorLaunch({ preset: "vscode", customCommand: "" }, path, env)).toEqual({
      ok: true,
      spec: { command: "open", args: ["-b", "com.microsoft.VSCode", path], windowsHide: true },
    });
    expect(buildTerminalLaunch({ preset: "iterm", customCommand: "" }, path, env)).toMatchObject({
      ok: true,
      spec: { command: "open", args: ["-a", "iTerm", path] },
    });
  });

  it("Linux 在 PATH 中找編輯器與終端機", () => {
    const env = posixEnv("linux", ["/usr/bin/code", "/usr/bin/gnome-terminal"]);
    expect(buildEditorLaunch({ preset: "vscode", customCommand: "" }, path, env)).toEqual({
      ok: true,
      spec: { command: "/usr/bin/code", args: [path], cwd: path, windowsHide: true },
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
