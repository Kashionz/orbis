import type { DesktopBridge } from "@orbis/desktop/bridge";
import { describe, expect, it, vi } from "vitest";
import { logout } from "./logout";

function bridge(proceed: boolean, calls: string[]): DesktopBridge {
  return {
    getVersion: async () => "0.0.0",
    openWorktreeInEditor: async () => ({ ok: true }),
    openWorktreeInTerminal: async () => ({ ok: true }),
    beforeLogout: async () => {
      calls.push("beforeLogout");
      return { proceed };
    },
  };
}

describe("logout", () => {
  it("在 Desktop 中先呼叫 beforeLogout()，放行後才送出登出", async () => {
    const calls: string[] = [];
    const send = vi.fn(async () => {
      calls.push("logout");
    });
    await expect(logout(bridge(true, calls), send)).resolves.toBe(true);
    expect(calls).toEqual(["beforeLogout", "logout"]);
  });

  it("beforeLogout() 回 proceed: false 時不登出", async () => {
    const calls: string[] = [];
    const send = vi.fn(async () => {});
    await expect(logout(bridge(false, calls), send)).resolves.toBe(false);
    expect(calls).toEqual(["beforeLogout"]);
    expect(send).not.toHaveBeenCalled();
  });

  it("一般瀏覽器中沒有 bridge，直接登出", async () => {
    const send = vi.fn(async () => {});
    await expect(logout(null, send)).resolves.toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it("登出請求失敗時把錯誤丟出去", async () => {
    const send = vi.fn(async () => {
      throw new Error("HTTP 500");
    });
    await expect(logout(null, send)).rejects.toThrow("HTTP 500");
  });
});
