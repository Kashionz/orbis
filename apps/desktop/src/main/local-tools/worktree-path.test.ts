import { NAMES } from "@orbis/api-contract/names";
import { describe, expect, it } from "vitest";
import { checkWorktreePath, type WorktreePathEnv, worktreeRoot } from "./worktree-path";

function env(
  platform: NodeJS.Platform,
  dirs: string[],
  links: Record<string, string> = {},
): WorktreePathEnv {
  const fold = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  const set = new Set(dirs.map(fold));
  return {
    platform,
    home: "/home/me",
    isDirectory: (p) => set.has(fold(p)),
    realpath: (p) => links[p] ?? p,
  };
}

const WIN_ROOT = NAMES.worktreeRootWindows;

describe("worktreeRoot", () => {
  it("Windows 用短路徑根目錄，其他平台展開 ~", () => {
    expect(worktreeRoot("win32", "C:\\Users\\me")).toBe(WIN_ROOT);
    expect(worktreeRoot("linux", "/home/me")).toBe(NAMES.worktreeRootUnix.replace("~", "/home/me"));
  });
});

describe("checkWorktreePath（Windows）", () => {
  const inside = `${WIN_ROOT}\\my repo\\ORB-12`;

  it("接受根目錄底下存在的目錄，並正規化磁碟代號與斜線", () => {
    const e = env("win32", [inside]);
    expect(checkWorktreePath(inside, e)).toEqual({ ok: true, path: inside });
    const lower = inside.replace(/^C:/, "c:").replaceAll("\\", "/");
    expect(checkWorktreePath(lower, e)).toEqual({ ok: true, path: inside });
  });

  it("拒絕根目錄本身、根目錄以外、用 .. 跳出的路徑", () => {
    const e = env("win32", [WIN_ROOT, "C:\\Windows", `${WIN_ROOT}x\\a`]);
    for (const p of [WIN_ROOT, "C:\\Windows", `${WIN_ROOT}\\..\\Windows`, `${WIN_ROOT}x\\a`]) {
      expect(checkWorktreePath(p, e), p).toMatchObject({
        ok: false,
        reason: "outside_worktree_root",
      });
    }
  });

  it("拒絕相對路徑、空字串與非字串", () => {
    const e = env("win32", []);
    for (const p of ["my repo\\ORB-12", "", "  ", 42, null, `${WIN_ROOT}\\a\0b`]) {
      expect(checkWorktreePath(p, e)).toMatchObject({ ok: false, reason: "invalid_path" });
    }
  });

  it("目錄不存在時回報 not_found", () => {
    expect(checkWorktreePath(inside, env("win32", []))).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("checkWorktreePath（macOS／Linux）", () => {
  const root = worktreeRoot("linux", "/home/me");

  it("接受根目錄底下的目錄", () => {
    expect(checkWorktreePath(`${root}/repo/ORB-1`, env("linux", [`${root}/repo/ORB-1`]))).toEqual({
      ok: true,
      path: `${root}/repo/ORB-1`,
    });
  });

  it("經由 symlink 指到根目錄以外時拒絕", () => {
    const link = `${root}/repo/escape`;
    expect(checkWorktreePath(link, env("linux", [link], { [link]: "/etc" }))).toMatchObject({
      ok: false,
      reason: "outside_worktree_root",
    });
  });
});
