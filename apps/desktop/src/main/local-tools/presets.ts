// 「用編輯器開啟 Worktree」與「在終端機開啟」可以選的程式。自訂指令中的 `{path}` 會換成 Worktree 路徑。

export const PATH_PLACEHOLDER = "{path}";

export interface ToolPreset {
  id: string;
  label: string;
}

export const CUSTOM_PRESET: ToolPreset = { id: "custom", label: "自訂指令" };

export const EDITOR_PRESETS: readonly ToolPreset[] = [
  { id: "vscode", label: "Visual Studio Code" },
  { id: "cursor", label: "Cursor" },
  CUSTOM_PRESET,
];

const TERMINAL_PRESETS: Record<"win32" | "darwin" | "linux", readonly ToolPreset[]> = {
  win32: [
    { id: "windows-terminal", label: "Windows Terminal" },
    { id: "powershell", label: "PowerShell" },
    { id: "cmd", label: "命令提示字元（cmd）" },
    { id: "git-bash", label: "Git Bash" },
    CUSTOM_PRESET,
  ],
  darwin: [{ id: "terminal", label: "Terminal" }, { id: "iterm", label: "iTerm" }, CUSTOM_PRESET],
  linux: [
    { id: "x-terminal-emulator", label: "系統預設終端機（x-terminal-emulator）" },
    { id: "gnome-terminal", label: "GNOME Terminal" },
    { id: "konsole", label: "Konsole" },
    CUSTOM_PRESET,
  ],
};

export function terminalPresets(platform: NodeJS.Platform): readonly ToolPreset[] {
  if (platform === "win32" || platform === "darwin") return TERMINAL_PRESETS[platform];
  return TERMINAL_PRESETS.linux;
}

export interface ToolChoice {
  preset: string;
  /** preset 為 `custom` 時使用，例如 `alacritty --working-directory {path}`。 */
  customCommand: string;
}

export function defaultEditor(): ToolChoice {
  return { preset: "vscode", customCommand: "" };
}

export function defaultTerminal(platform: NodeJS.Platform): ToolChoice {
  return { preset: terminalPresets(platform)[0]?.id ?? CUSTOM_PRESET.id, customCommand: "" };
}
