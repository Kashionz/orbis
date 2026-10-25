import { describe, expect, it, vi } from "vitest";
import { revealWorktree } from "./reveal";
import { checkWorktreePath } from "./worktree-path";

const check = (input: unknown) =>
  checkWorktreePath(input, {
    platform: "win32",
    home: "C:\\Users\\me",
    isDirectory: (p) => p.toLowerCase().startsWith("c:\\ob\\web\\"),
    realpath: (p) => p,
  });

describe("revealWorktree", () => {
  it("路徑檢查通過後以 shell.openPath 開啟", async () => {
    const openPath = vi.fn(async () => "");
    const result = await revealWorktree("c:/ob/web/ORB-1-1", { check, openPath });
    expect(result).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith("C:\\ob\\web\\ORB-1-1");
  });

  it("Worktree 根目錄以外的路徑不開啟", async () => {
    const openPath = vi.fn(async () => "");
    for (const bad of ["C:\\Windows", "C:\\ob\\web", "C:\\ob\\web\\ORB-1-1\\src", 42, ""]) {
      const result = await revealWorktree(bad, { check, openPath });
      expect(result.ok).toBe(false);
    }
    expect(openPath).not.toHaveBeenCalled();
  });

  it("shell.openPath 回報錯誤時回傳給 Web UI", async () => {
    const result = await revealWorktree("C:\\ob\\web\\ORB-1-1", {
      check,
      openPath: async () => "找不到應用程式",
    });
    expect(result).toEqual({ ok: false, message: "無法開啟 C:\\ob\\web\\ORB-1-1：找不到應用程式" });
  });
});
